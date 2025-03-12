import OpenAI from 'openai';
import {
  Client,
  ChatCompletionEvents,
  Options,
  Message,
  WorkspaceMessageKey,
  WorkspaceMessagesProxy,
  WorkspaceModulesProxy,
} from './types/globals';
import { uuid } from 'uuidv4';
import assistantController from '../src/controllers/assistantController';
import { calculateTokens4o_mini, commandDecomposition, commandTypeEnum, createModule, createModuleFromOutline, generateModuleOutlineResponse, insertModuleNode, intentDecomposition, IntentTypeEnum, ModuleNodeOutline } from './utils/ai/ai-utils';
import { ChatCompletionMessageParam } from 'openai/resources';
import { serializeTuple } from './socketServer';
import moduleController from './controllers/moduleController';
import { getContext } from './utils/context';

enum MessageType {
  Standard = "standard",
  Action = "action"
}

class AISocketHandler {
  public openai: OpenAI;

  constructor(
    public client: Client,
    public options: Options = {
      verbose: false,
      chat: { model: 'gpt-4o-mini' },
      initMessages: [
        { role: 'system', content: 'You are a helpful assistant.' },
      ],
    },
    // public clients: Map<string, Client>,
    public workspaceMessagesBufferProxy: WorkspaceMessagesProxy,
    public workspaceModulesBufferProxy: WorkspaceModulesProxy,
  ) {
    this.openai = new OpenAI(this.options.client);
    
    // Standard user-assistant message events handling
    client.on('new-message', async (message, userId, workspaceId, chatHistory) => {
      try {
        await this.onNewMessage(client, message, workspaceId, userId, chatHistory)
      } catch(error) {
        console.log("Error processing message to assistant: ", error);
      }
    });

    // TODO: Modify this so that all AI assistant operations over a workspace ID is terminated
    client.on('abort', () => { 
      if (client.data.currentChatStream) {
        client.data.currentChatStream.controller.abort();
        client.data.currentChatStream = undefined;
      }
    });

    client.on('module-outline-generation', async (confirmation, workspaceId, subject, context_instructions) => {
      if (confirmation) {
        try {
          const userMessageId = uuid();
          const actionNotificationDirective = `::action_notification{actionMessage="Module Outline Creation Confirmed"}`;
          client.emit('initialize-user-message', userMessageId, actionNotificationDirective, MessageType.Action, workspaceId, async ({ ack }) => {
            if (ack === 'success') {
                await assistantController.insertChatHistory(
                  {
                    role: 'user',
                    content: actionNotificationDirective,
                  },
                  userMessageId,
                  MessageType.Action,
                  workspaceId
                );
        
                const assistantMessageId = uuid();
                client.emit('initialize-assistant-message', assistantMessageId, MessageType.Action, workspaceId, async ({ ack }) => {
                  if (ack === 'success') {
                    const moduleId = uuid();
                    const moduleDirective = `:::module_outline{moduleId="${moduleId}" subject="${subject}" context_instructions="${context_instructions}"}\n:::`;
                    client.emit('content', moduleDirective, moduleDirective as any, assistantMessageId, workspaceId);
            
                    await assistantController.insertChatHistory(
                      {
                        role: 'assistant',
                        content: moduleDirective,
                      },
                      assistantMessageId,
                      MessageType.Action,
                      workspaceId
                    );
            
                    client.emit('end', workspaceId);
                  }
                });
            }
          });
        } catch(error) {
          console.error("Error generating module outline: ", error);
        }
      } else {
        try {
          const userMessageId = uuid();
          const actionNotificationDirective = `::action_notification{actionMessage="Module Creation Confirmed"}`;
  
          client.emit('initialize-user-message', userMessageId, actionNotificationDirective, MessageType.Action, workspaceId, async({ ack }) => {
            if (ack === 'success') {
              client.emit('end', workspaceId);
  
              await assistantController.insertChatHistory(
                {
                  role: 'user',
                  content: actionNotificationDirective,
                },
                userMessageId,
                MessageType.Action,
                workspaceId
              );
      
              // Handle direct module outline generation without user confirmation
              let moduleOutlineData = await generateModuleOutlineResponse(this.openai, subject, context_instructions);
      
              const result = await moduleController.createModuleCallback(moduleOutlineData.name, moduleOutlineData.description, workspaceId);
              const rootNode = result.moduleId;

              await Promise.all(
                moduleOutlineData.moduleNodes.map(async (node: ModuleNodeOutline, index: number) => {
                  await insertModuleNode(rootNode!, node, rootNode!, index, 1);
                })
              );

              console.log("Module nodes of prev:", JSON.stringify(moduleOutlineData.moduleNodes, null, 2));
      
              await createModuleFromOutline(client, moduleOutlineData, result, workspaceId, rootNode!, subject, context_instructions, workspaceModulesBufferProxy, this.openai);
  
            }
          });
        } catch(error) {
          console.error("Error generating module: ", error);
        }
      }
    });

    client.on('module-outline-inject-content', async(workspaceId, assistantMessageId, moduleId, subject, context_instructions) => {
      console.log('User requested to generate module outline');
      client.removeAllListeners('directive-ready');

      // Function to handle the directive-ready event
      const handleDirectiveReady = async (receivedAssistantMessageId: string, receivedWorkspaceId: string) => {
        if (receivedAssistantMessageId === assistantMessageId && receivedWorkspaceId === workspaceId) {
          // clearTimeout(timeoutId); // Clear the timeout since the correct event was received
  
          let moduleOutlineData = await generateModuleOutlineResponse(this.openai, subject, context_instructions);
          client.emit('module-outline-data', assistantMessageId, workspaceId, moduleId, JSON.stringify(moduleOutlineData));
          
          client.removeAllListeners('directive-ready');

          client.emit('end', workspaceId);
          // attachConfirmModuleReponseListener(receivedAssistantMessageId, receivedWorkspaceId, handleDirectiveReady);
        } else {
          console.warn('Received directive-ready event with mismatched assistantMessageId or workspaceId');
          // client.once('directive-ready', handleDirectiveReady);
        }
      };
  
      client.once('directive-ready', handleDirectiveReady);
    });

    client.on('confirm-module-outline-response', async(action, workspaceId, moduleId, module, subject, context_instructions) => {
      if (action === 'submit') {
        try {
          console.log('User accepted the module outline');
          const userMessageId = uuid();
          const actionNotificationDirective = `::action_notification{actionMessage="Module Outline Accepted by User"}`;
  
          client.emit('initialize-user-message', userMessageId, actionNotificationDirective, MessageType.Action, workspaceId, async ({ ack }) => {
            if (ack === 'success') {
              await assistantController.insertChatHistory(
                {
                  role: 'user',
                  content: actionNotificationDirective,
                },
                userMessageId,
                MessageType.Action,
                workspaceId
              );
      
              const result = await moduleController.createModuleCallback(module.name, module.description, workspaceId, moduleId);
              const rootNode = result.moduleId;
            
              await Promise.all(
                module.nodes.map(async (node: ModuleNodeOutline, index: number) => {
                  await insertModuleNode(rootNode!, node, rootNode!, index, 1);
                })
              );

              // Generate the Module
              await createModule(client, moduleId, workspaceId, module, subject, context_instructions, workspaceModulesBufferProxy, this.openai);
            }
          });
        } catch(error) {
          console.error("Error generating module: ", error);
        }
      } else if (action === 'cancel') {
        try {
          console.log('User canceled the module outline generation');
          const userMessageId = uuid();
          const actionNotificationDirective = `::action_notification{actionMessage="Module Outline Rejected by User"}`;
  
          client.emit('initialize-user-message', userMessageId, actionNotificationDirective, MessageType.Action, workspaceId, async({ ack }) => {
            if (ack == 'success') {
              await assistantController.insertChatHistory(
                {
                  role: 'user',
                  content: actionNotificationDirective,
                },
                userMessageId,
                MessageType.Action,
                workspaceId
              );
      
              // End assistant message sequence
              client.emit('end', workspaceId);
            }
          });
        } catch(error) {
          console.error("Unexpected error in cancelling module outline generation: ", error);
        }
      }
    })
  }    


    
  private async onNewMessage(client: Client, message: string | Message, workspaceId: string, userId: string, chatHistory: Message[]): Promise<void> {
    if (typeof message === 'object') {
      chatHistory.push(message);
    } else {
      const userTokens = await calculateTokens4o_mini(message);
      const userMessageId = uuid();

      client.emit('initialize-user-message', userMessageId, message, MessageType.Standard, workspaceId, async ({ ack }) => {
        console.log("Ack user message: ", ack);
        if (ack === 'success') {
          try {
            chatHistory.push({
              role: 'user',
              content: message,
            });
      
            await assistantController.insertChatHistory(
              {
                role: 'user',
                content: message,
              },
              userMessageId,
              MessageType.Standard,
              workspaceId
            );
            await this.processMessagePipeline(client, message, workspaceId, userTokens, chatHistory);
          } catch (error) {
            console.error("Error processing pipeline: ", error);
            throw error;
          }
        }
      });
    }
  }

  private async processMessagePipeline(client: Client, message: string, workspaceId: string, userTokens: number, chatHistory: Message[]): Promise<void> {
    const intentDecompositionCompletion = await intentDecomposition(this.openai, message);
    let context;

    switch(intentDecompositionCompletion.parsed?.intent_type) {
      case IntentTypeEnum.Values.query:
        console.log("query pipeline");
        try {
          context = await getContext(intentDecompositionCompletion.parsed.subject, workspaceId, 0.4);
          
          if (context?.length === 0) {
            const assistantMessageId = uuid();
            client.emit('initialize-assistant-message', assistantMessageId, MessageType.Action, workspaceId, async ({ ack }) => {
              if (ack === 'success') {
                const notificationDirective = `::rag_empty_context_notification{notificationMessage="No relevant information found about topic within the workspace. Assistant response information may be inaccurate. Try adding files to the workspace that contains relevant information."}`;
                client.emit('content', notificationDirective, notificationDirective as any, assistantMessageId, workspaceId);
                
                client.emit('end', workspaceId);
      
                assistantController.insertChatHistory(
                  {
                    role: 'assistant',
                    content: notificationDirective,
                  },
                  assistantMessageId,
                  MessageType.Action,
                  workspaceId
                );
              }
            });
  
          }
          else {
            console.log(context)
            const systemPrompt =
              `You are an AI agent that's answers the user's query. You will be given relevant context information from a RAG pipeline in regards to the query. If no context information is supplied , ust answer normally based on your available knowledge. Otherwise, base your response on the information within the context block.

              subject: ${intentDecompositionCompletion.parsed.subject}
              context_instructions: ${intentDecompositionCompletion.parsed.context_instructions}
      
              CONTEXT INFORMATION BLOCK:
              ---
              ${context}
              ---
              `;

            const systemPromptParam = [{ role: 'system', content: systemPrompt }] as ChatCompletionMessageParam[];

            try {
              await this.processNewMessage(
                  client,
                  systemPromptParam,
                  workspaceId,
                  chatHistory,
                  userTokens);
            } catch(error){
              console.error("Error generating query response:", error);
              throw error;
            }
          }
        } catch (error) {
          console.error("Error getting context:", error);
          throw error;
        }
        break;
      case IntentTypeEnum.Values.command:
        console.log("command pipeline");
        
        context = await getContext(intentDecompositionCompletion.parsed.subject, workspaceId, 0.6);

        if (context?.length === 0) {
          const assistantMessageId = uuid();
          client.emit('initialize-assistant-message', assistantMessageId, MessageType.Action, workspaceId, async ({ ack }) => {
            if (ack === 'success') {
              const notificationDirective = `::rag_empty_context_notification{notificationMessage="No relevant information found about topic within the workspace. Assistant response information may be inaccurate. Try adding files to the workspace that contains relevant information."}`;
              client.emit('content', notificationDirective, notificationDirective as any, assistantMessageId, workspaceId);
              
              client.emit('end', workspaceId);
    
              assistantController.insertChatHistory(
                {
                  role: 'assistant',
                  content: notificationDirective,
                },
                assistantMessageId,
                MessageType.Action,
                workspaceId
              );
            }
          });
        }
        else{
          const commandTypeCompletion = await commandDecomposition(this.openai, intentDecompositionCompletion.parsed?.context_instructions);
          console.log("Command type:", commandTypeCompletion.parsed?.command_type);

          try {
            await this.commandPipelineProcessing(
              client, 
              commandTypeCompletion.parsed?.command_type,
              intentDecompositionCompletion.parsed.subject,
              intentDecompositionCompletion.parsed.context_instructions,
              workspaceId,
              chatHistory,
              userTokens
            )
          } catch(error){
            console.error("Error generating query response:", error);
            throw error;
          }
        }
        break;
      case IntentTypeEnum.Values.informative:
        console.log("informative pipeline");
        // this.processNewMessage(client, workspaceId, chatHistory, userTokens);
        break;
      case IntentTypeEnum.Values.conversational:
        console.log("conversational pipeline");
        const conversationalSystemPrompt = [{ role: 'system', content: "The user has given a simple greeting/started a conversation. Give a polite response." }] as ChatCompletionMessageParam[];
        try {
          await this.processNewMessage(client, conversationalSystemPrompt, workspaceId, chatHistory, userTokens);
        } catch(error){
          console.error("Error generating query response:", error);
          throw error;
        }
        break;
      default:
        console.log("misc pipeline");
        const miscSystemPrompt = [{ role: 'system', content: "The user has given a nonsensical/incoherent/out-of-context query as input. Please kindly ask what their intention was politely, or guide them." }] as ChatCompletionMessageParam[];
        try {
          await this.processNewMessage(client, miscSystemPrompt, workspaceId, chatHistory, userTokens);
        } catch(error){
          console.error("Error generating query response:", error);
          throw error;
        }
        break;
    }
  }

  private async processNewMessage(client: Client, systemPromptParam: ChatCompletionMessageParam[], workspaceId: string, chatHistory: Message[], userTokens: number): Promise<void> {
    console.log("Processing new message for: ", workspaceId);
    console.log("System prompt: \n", systemPromptParam[0].content);

    const assistantMessageId = uuid();

    const tupleKey: WorkspaceMessageKey = [assistantMessageId, workspaceId];
    const serializedKey = serializeTuple(tupleKey);

    // Hacky bandaid fix for weird callback behavior via proxy. Do not modify until socket.io is patched. 
    this.workspaceMessagesBufferProxy.emit(serializedKey, 'initialize-assistant-message', assistantMessageId, MessageType.Standard, workspaceId, async ({ ack }: any) => {});
    client.emit('initialize-assistant-message', assistantMessageId, MessageType.Standard, workspaceId, async ({ ack }: any) => {
      console.log("Ack assistant message: ", ack);
      if (ack === 'success') {
        const stream = this.openai.beta.chat.completions.stream({
          model: "gpt-4o-mini",
          messages: [...systemPromptParam, ...chatHistory],
        });
    
        const streamHandlers = {
          content: (contentDelta, contentSnapshot) => {
            this.workspaceMessagesBufferProxy.set(serializedKey, [contentDelta, JSON.stringify(contentSnapshot)]);
          },
          finalContent: (contentSnapshot) =>
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalContent', contentSnapshot, workspaceId),
          chunk: (chunk, snapshot) => this.workspaceMessagesBufferProxy.emit(serializedKey, 'chunk', chunk, snapshot, workspaceId),
          chatCompletion: async (completion) => {
            const assistantTokens = await calculateTokens4o_mini(completion.choices[0].message.content);
            const usage = {
              prompt_tokens: userTokens,
              completion_tokens: assistantTokens,
              total_tokens: userTokens + assistantTokens,
            };
            const completionWithUsage = {
              ...completion,
              usage: usage
            };
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'chatCompletion', completionWithUsage, workspaceId);
          },
          finalChatCompletion: async (completion) => {
            const assistantTokens = await calculateTokens4o_mini(completion.choices[0].message.content);
            const usage = {
              prompt_tokens: userTokens,
              completion_tokens: assistantTokens,
              total_tokens: userTokens + assistantTokens,
            };
            const completionWithUsage = {
              ...completion,
              usage: usage
            };
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalChatCompletion', completionWithUsage, workspaceId);
          },
          message: (message) => this.workspaceMessagesBufferProxy.emit(serializedKey, 'message', message, workspaceId),
          finalMessage: async (message) => {
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalMessage', message, workspaceId);
            try {
              await assistantController.insertChatHistory(
                message,
                assistantMessageId,
                MessageType.Standard,
                workspaceId
              );
            } catch(error) {
              throw error;
            }
          },
          functionCall: (functionCall) => this.workspaceMessagesBufferProxy.emit(serializedKey, 'functionCall', functionCall, workspaceId),
          finalFunctionCall: (finalFunctionCall) =>
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalFunctionCall', finalFunctionCall, workspaceId),
          functionCallResult: (finalFunctionCallResult) =>
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalFunctionCallResult', finalFunctionCallResult, workspaceId),
          finalFunctionCallResult: (finalFunctionCallResult, workspaceId) =>
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalFunctionCallResult', finalFunctionCallResult, workspaceId),
          error: (error) => {
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'error', error, workspaceId);
          },
          end: () => {
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'end', workspaceId);
            this.workspaceMessagesBufferProxy.emit(serializedKey, 'debug-log', JSON.stringify({ debug: "Intermediate response ended." }))
          },
        } as ChatCompletionEvents;
    
        Object.entries(streamHandlers).forEach(([event, handler]) => {
          stream.on(
            event as keyof typeof streamHandlers,
            async (...args: any) => {
              await handler(...args);
            },
          );
        });
      }
    });
  }

  private async intermediateResponse(client: Client, subject: string, context_instructions: string, piplineStatus: string, workspaceId: string, chatHistory: Message[], userTokens: number): Promise<string | void> {
    console.log("Generating intermediate response...");
    const assistantMessageId = uuid();

    const tupleKey: WorkspaceMessageKey = [assistantMessageId, workspaceId];
    const serializedKey = serializeTuple(tupleKey);
    
    let finalIntermediateResponse: string = '';

    return new Promise((resolve, reject) => {
      // Hacky bandaid fix for weird callback behavior via proxy. Do not modify until socket.io is patched. 
      this.workspaceMessagesBufferProxy.emit(serializedKey, 'initialize-assistant-message', assistantMessageId, MessageType.Standard, workspaceId, async ({ ack }: any) => {});
      client.emit('initialize-assistant-message', assistantMessageId, MessageType.Standard, workspaceId, async ({ ack }: any) => {
        console.log("Ack intermediate response: ", ack);
        if (ack === 'success') {
          const systemPrompt = 
          `You are an AI agent that's part of a user input processing pipeline who's main task is to give short, intermediate responses to the user depending on the [subject] and the [context_instructions] if applicable. Give your responses as if you are reassuring the user that their request is being processed.
      
          pipelineStatus: ${piplineStatus}
          subject: ${subject}
          context_instructions: ${context_instructions}`;
      
          const systemPromptParam = [{ role: 'system', content: systemPrompt }] as ChatCompletionMessageParam[];
      
          const stream = this.openai.beta.chat.completions.stream({
            model: "gpt-4o-mini",
            messages: [...systemPromptParam, ...chatHistory],
          });
      
          const streamHandlers = {
            content: (contentDelta, contentSnapshot) => {
              this.workspaceMessagesBufferProxy.set(serializedKey, [contentDelta, JSON.stringify(contentSnapshot)]);
            },
            finalContent: (contentSnapshot) =>
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalContent', contentSnapshot, workspaceId),
            chunk: (chunk, snapshot) => this.workspaceMessagesBufferProxy.emit(serializedKey, 'chunk', chunk, snapshot, workspaceId),
            chatCompletion: async (completion) => {
              const assistantTokens = await calculateTokens4o_mini(completion.choices[0].message.content);
              const usage = {
                prompt_tokens: userTokens,
                completion_tokens: assistantTokens,
                total_tokens: userTokens + assistantTokens,
              };
              const completionWithUsage = {
                ...completion,
                usage: usage
              };
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'chatCompletion', completionWithUsage, workspaceId);
            },
            finalChatCompletion: async (completion) => {
              const assistantTokens = await calculateTokens4o_mini(completion.choices[0].message.content);
              const usage = {
                prompt_tokens: userTokens,
                completion_tokens: assistantTokens,
                total_tokens: userTokens + assistantTokens,
              };
              const completionWithUsage = {
                ...completion,
                usage: usage
              };
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalChatCompletion', completionWithUsage, workspaceId);
            },
            message: (message) => this.workspaceMessagesBufferProxy.emit(serializedKey, 'message', message, workspaceId),
            finalMessage: async (message) => {
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalMessage', message, workspaceId);
              finalIntermediateResponse = message.content as string;
              try {
                await assistantController.insertChatHistory(
                  message,
                  assistantMessageId,
                  MessageType.Standard,
                  workspaceId
                ).then(() => resolve(finalIntermediateResponse));
                  
                
              } catch(error) {
                throw error;
              }
            },
            functionCall: (functionCall) => this.workspaceMessagesBufferProxy.emit(serializedKey, 'functionCall', functionCall, workspaceId),
            finalFunctionCall: (finalFunctionCall) =>
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalFunctionCall', finalFunctionCall, workspaceId),
            functionCallResult: (finalFunctionCallResult) =>
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalFunctionCallResult', finalFunctionCallResult, workspaceId),
            finalFunctionCallResult: (finalFunctionCallResult, workspaceId) =>
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'finalFunctionCallResult', finalFunctionCallResult, workspaceId),
            error: (error) => {
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'error', error, workspaceId);
            },
            end: () => {
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'end', workspaceId);
              this.workspaceMessagesBufferProxy.emit(serializedKey, 'debug-log', JSON.stringify({ debug: "Intermediate response ended." }))
            },
          } as ChatCompletionEvents;
      
          Object.entries(streamHandlers).forEach(([event, handler]) => {
            stream.on(
              event as keyof typeof streamHandlers,
              async (...args: any) => {
                await handler(...args);
              },
            );
          });
      
          // Wait until the stream is finished before returning the final response
          // stream.on('end', () => {
          //   resolve(finalIntermediateResponse);
          // });
          stream.on('error', (error: any) => {
            reject(error);
          });
        }
      });
    });
  }

  private async commandPipelineProcessing(client: Client, commandTypeCompletion: string, subject: string, context_instructions: string, workspaceId: string, chatHistory: Message[], userTokens: number): Promise<void> {
    
    switch(commandTypeCompletion) {
      case commandTypeEnum.Values.create_module:
        try {
          let context;
          // try {
            // context = await getContext(subject, workspaceId);
          //   console.log("CONTEXT:-----------" + context);

          //   if (context?.length === 0) {
          //     const assistantMessageId = uuid();
          //     client.emit('initialize-assistant-message', assistantMessageId, MessageType.Action, workspaceId, async ({ ack }) => {
          //       if (ack === 'success') {
          //         const notificationDirective = `::rag_empty_context_notification{notificationMessage="No relevant information found about topic within the workspace. Assistant response information may be inaccurate. Try adding files to the workspace that contains relevant information."}`;
          //         client.emit('content', notificationDirective, notificationDirective as any, assistantMessageId, workspaceId);
                  
          //         client.emit('end', workspaceId);
        
          //         await assistantController.insertChatHistory(
          //           {
          //             role: 'assistant',
          //             content: notificationDirective,
          //           },
          //           assistantMessageId,
          //           MessageType.Action,
          //           workspaceId
          //         );
          //       }
          //     });
          //     return; // Exit early if no context found
          //   }

          //   // If context exists, proceed with module creation
          //   const intermediateResponseMessage = await this.intermediateResponse(
          //     client,
          //     subject,
          //     context_instructions,
          //     `The user needs to confirm if they want to generate the module outline first or directly generate the module and let the system decide the outline directly without confirmation.`,
          //     workspaceId,
          //     chatHistory.slice(-1),
          //     userTokens
          //   );

          //   if (intermediateResponseMessage) {
          //     console.log("Generating assistant message...");

          //     const assistantMessageId = uuid();
          //     client.emit('initialize-assistant-message', assistantMessageId, MessageType.Action, workspaceId, async ({ ack }) => {
          //       if (ack === 'success') {
          //         const moduleOutlineConfirmDirective = `\n\n::module_outline_generation_confirm{subject="${subject}" context_instructions="${context_instructions}"}\n\n`;
          //         client.emit('content', moduleOutlineConfirmDirective, moduleOutlineConfirmDirective as any, assistantMessageId, workspaceId);
                  
          //         client.emit('end', workspaceId);
        
          //         await assistantController.insertChatHistory(
          //           {
          //             role: 'assistant',
          //             content: moduleOutlineConfirmDirective,
          //           },
          //           assistantMessageId,
          //           MessageType.Action,
          //           workspaceId
          //         );
          //       }
          //     });
          //   }
          // } catch (error) {
          //   console.error("Error getting context:", error);
          //   throw error;
          // }
          const intermediateResponseMessage = await this.intermediateResponse(
            client,
            subject,
            context_instructions,
            `The user needs to confirm if the wants to generate the module outline first or directly generate the module and let the system decide the outline directly without confirmation.`,
            workspaceId,
            chatHistory.slice(-1),
            userTokens
          );
          console.log("Intermediate reponse:", intermediateResponseMessage);
          
          if (intermediateResponseMessage) {
            console.log("Generating assistant message...");

            const assistantMessageId = uuid();
            client.emit('initialize-assistant-message', assistantMessageId, MessageType.Action, workspaceId, async ({ ack }) => {
              if (ack === 'success') {
                const moduleOutlineConfirmDirective = `\n\n::module_outline_generation_confirm{subject="${subject}" context_instructions="${context_instructions}"}\n\n`;
                client.emit('content', moduleOutlineConfirmDirective, moduleOutlineConfirmDirective as any, assistantMessageId, workspaceId);
                
                client.emit('end', workspaceId);
      
                await assistantController.insertChatHistory(
                  {
                    role: 'assistant',
                    content: moduleOutlineConfirmDirective,
                  },
                  assistantMessageId,
                  MessageType.Action,
                  workspaceId
                );
              }
            });
            
            // Go to `module-outline-generation` listener for pipeline flow continuation
          }

        } catch(error) {
          console.error("Error generating intermediate response: ", error);
        }

        break;
      case commandTypeEnum.Values.create_assessment:
        break;
      case commandTypeEnum.Values.reorganize_module:
        break;
      case commandTypeEnum.Values.reorganize_assessment:
        break;
      case commandTypeEnum.Values.rewrite_module_page:
        break;
      case commandTypeEnum.Values.rewrite_module_page_section:
        break;
      default:
        break;
    }
  }

  logger(message: string): void {
    console.debug(`[AISocketHandler] ${message}`);
  }
}

export default AISocketHandler;
