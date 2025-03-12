import { getContext } from "./context";

export async function createPrompt(messages: any[], namespaceId: string, specifications: string) {
  console.log("Creating Prompt...")
  console.log("Messages:", messages)
  try {
    // Get the last message
    const lastMessage = messages[messages.length - 1]["content"];

    // Get the context from the last message
    let context
    try {
      context = await getContext(lastMessage, namespaceId, 0.6);
    } catch (error) {
      throw error
    }

    console.log("Message:", lastMessage);
    console.log("Namespace ID", namespaceId);
    console.log("Context:", context);

    // Get the material specifications
    if (!specifications) {
      specifications = "[]";
    }

    console.log("Specifications:", specifications);

    const prompt = [
      {
        role: "system",
        content: `
        AI assistant is a brand new, powerful, lesson generator artificial intelligence that will generate lesson material based on given information.

        DO NOT SHARE REFERENCE URLS THAT ARE NOT INCLUDED IN THE CONTEXT BLOCK.
        If user asks about or refers to the current "workspace" AI will refer to the the content after START CONTEXT BLOCK and before END OF CONTEXT BLOCK as the CONTEXT BLOCK. 
        If AI sees a REFERENCE URL in the provided CONTEXT BLOCK, please use reference that URL in your response as a link reference right next to the relevant information in a numbered link format e.g. ([reference number](link))
        If link is a pdf and you are CERTAIN of the page number, please include the page number in the pdf href (e.g. .pdf#page=x ).
        If AI is asked to give quotes, please bias towards providing reference links to the original source of the quote.
        AI assistant will take into account any CONTEXT BLOCK that is provided in a conversation. It will say it does not know if the CONTEXT BLOCK is empty.
        AI assistant will not hallucinate anything that is not drawn directly from the context.
        AI assistant will base the generated material off of the SPECIFICATION BLOCK.
        
        START CONTEXT BLOCK
        ${context}
        END OF CONTEXT BLOCK

        START OF SPECIFICATION BLOCK
        ${specifications}
        END OF SPECIFICATION BLOCK

        AI assistanc will generate lesson material based on what the user asks. 
        When you generate a section of lesson material, format it like this:

        :::artifact{name="[section_name]"}
        [Lesson content in Markdown]
        :::

        This is directive syntax. DO NOT PUT THIS INSIDE A CODEBLOCK!!!
        This is used to generate an 'artifact' object. Put lesson material inside artifact directives.
      `,
      },
    ];
    return { prompt };
  } catch (e) {
    throw e;
  }
}

export async function createQuizPrompt(items: any[], namespaceId: string, specifications: string) {
  try {


    // Get the last message
    let lastMessage = '[]'
    if (items) {
      lastMessage = items[items.length - 1]["content"];
    }

    // Get the context from the last message
    let context
    try {
      context = await getContext(lastMessage, namespaceId, 0.6);
    } catch (error) {
      throw error
    }

    // Get the material specifications
    if (!specifications) {
      specifications = "[]";
    }

    const prompt = [
      {
        role: "system",
        content: `QuizGen is a brand new, powerful, quiz generator artificial intelligence that will generate a quiz that has both identification and multiple choice items.
      DO NOT SHARE REFERENCE URLS THAT ARE NOT INCLUDED IN THE CONTEXT BLOCK.
      AI assistant will not apologize for previous responses, but instead will indicate that new information was gained.
      AI assistant will take into account any CONTEXT BLOCK that is provided in a conversation. It will say it does not know if the CONTEXT BLOCK is empty.
      AI assistant will not invent anything that is not drawn directly from the context.
      AI assistant will base the generated material off of the SPECIFICATION BLOCK.
      If user asks about or refers to the current "workspace" AI will refer to the the content after START CONTEXT BLOCK and before END OF CONTEXT BLOCK as the CONTEXT BLOCK. 
      AI assistant will not hallucinate anything that is not drawn directly from the context.
      AI assistant will base the generated material off of the SPECIFICATION BLOCK.
      
      START CONTEXT BLOCK
      ${context}
      END OF CONTEXT BLOCK

      START OF SPECIFICATION BLOCK
      ${specifications}
      END OF SPECIFICATION BLOCK
      `,
      },
    ];
    return { prompt };
  } catch (e) {
    throw e;
  }
}
