import { parentPort, workerData } from "worker_threads";
import { chunkAndEmbedFile, processFile } from "../documentProcessor";
// import { analyzePdfLayout } from "../ai/document-analysis";
// import { processFlatJson, saveDebugJson } from "../rag/pdfSectionHierarchy";
// import { SectionNode } from "../../../src/models/documentModel";

async function processFileWorker() {
  const { documentData, documentType, documentName, documentId, documentUrl, materialId } = workerData;

  try {
    console.log("Document data:", [documentData, documentType, documentName, documentId, documentUrl, materialId]);

    // const response: SectionNode[] = await analyzePdfLayout(documentData, documentName);
    // console.log("PDF Layout Analyze result:", response);

    // const hierarchy = processFlatJson(response);
    // // console.log("Hierarchy", JSON.stringify(hierarchy, null, 2));

    // saveDebugJson(hierarchy, "../../../uploads/debug.json");

    const { confirmation, documentContent } = await processFile(
      documentName,
      documentType,
      documentData,
      documentId,
      materialId
    );

    if (confirmation === "Success") {
      const { document } = await chunkAndEmbedFile(
        documentId,
        documentContent,
        documentUrl,
      ); 
      parentPort?.postMessage({ document, documentData });
    }
    else {
      throw new Error('Failed to process file!');
    }

    // parentPort?.postMessage({ error: "Debug mode"});
  } catch (error: any) {
    parentPort?.postMessage({ error: error.message });
  }
}

processFileWorker();
