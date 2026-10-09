export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_STORED_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_DATA_URL_LENGTH = 4 * Math.ceil(MAX_STORED_IMAGE_BYTES / 3) + 64;

const MAX_IMAGE_DIMENSION = 2048;

export interface PreparedImage {
  dataUrl: string;
  name: string;
  width: number;
  height: number;
  optimized: boolean;
}

function readImageDataUrl(imageBlob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read this image. Please try another file."));
    };
    reader.onerror = () => reject(new Error("Could not read this image. Please try another file."));
    reader.onabort = () => reject(new Error("Could not read this image. Please try another file."));
    reader.readAsDataURL(imageBlob);
  });
}

function encodeImage(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((imageBlob) => {
      if (imageBlob) resolve(imageBlob);
      else reject(new Error("Could not process this image. Please try another file."));
    }, mimeType, 0.9);
  });
}

export async function prepareUploadedImage(imageFile: File): Promise<PreparedImage> {
  if (!ACCEPTED_IMAGE_TYPES.includes(imageFile.type)) {
    throw new Error("Use a JPG, PNG or WebP image.");
  }
  if (!imageFile.size || imageFile.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Choose a non-empty image smaller than 5 MB.");
  }

  let imageBitmap: ImageBitmap;
  try {
    imageBitmap = await createImageBitmap(imageFile);
  } catch {
    throw new Error("Could not read this image. Please try another file.");
  }

  try {
    const longestEdge = Math.max(imageBitmap.width, imageBitmap.height);
    if (imageFile.size <= MAX_STORED_IMAGE_BYTES && longestEdge <= MAX_IMAGE_DIMENSION) {
      return {
        dataUrl: await readImageDataUrl(imageFile),
        name: imageFile.name,
        width: imageBitmap.width,
        height: imageBitmap.height,
        optimized: false
      };
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process this image. Please try another file.");
    let imageScale = Math.min(1, MAX_IMAGE_DIMENSION / longestEdge);

    // Keep embedded images bounded so project snapshots and publish requests stay manageable.
    while (true) {
      canvas.width = Math.max(1, Math.round(imageBitmap.width * imageScale));
      canvas.height = Math.max(1, Math.round(imageBitmap.height * imageScale));
      context.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
      const imageBlob = await encodeImage(canvas, imageFile.type);
      if (imageBlob.size <= MAX_STORED_IMAGE_BYTES) {
        return {
          dataUrl: await readImageDataUrl(imageBlob),
          name: imageFile.name,
          width: canvas.width,
          height: canvas.height,
          optimized: true
        };
      }
      imageScale *= Math.min(0.8, Math.sqrt(MAX_STORED_IMAGE_BYTES / imageBlob.size) * 0.9);
    }
  } finally {
    imageBitmap.close();
  }
}
