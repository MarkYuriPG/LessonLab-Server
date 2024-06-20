import { parentPort, workerData } from "worker_threads";
import { chunkAndEmbedFile, processFile } from "../documentProcessor";

async function processFileWorker() {
  const { documentData, documentType, documentName, documentId, documentUrl } = workerData;

  try {
    const { confirmation } = await processFile(
      documentName,
      documentType,
      documentData,
      documentId
    );

    if (confirmation === "Success") {
      const { document } = await chunkAndEmbedFile(
        documentId,
        // documentUrl,
        // documentContent
      );
      parentPort?.postMessage({ document });
    }
    else {
      throw new Error('Failed to process file!');
    }
  } catch (error: any) {
    parentPort?.postMessage({ error: error.message });
  }
}

processFileWorker();
