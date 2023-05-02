import { Point, Size, Rectangle, ipcRenderer, nativeImage } from "electron";
import { defer, repeat } from "rxjs";

const sourceId = location.hash;
console.debug(`Configure capture window for '${sourceId}'`);

const fakeCanvas = document.createElement("canvas");
const img = new Image();
img.onload = () => {
  fakeCanvas.height = Math.min(img.height, 80);
  fakeCanvas.width = img.width;
  fakeCanvas.getContext("2d", { willReadFrequently: true })?.drawImage(img, 0, 0);
};
img.src = nativeImage.createFromPath("assets/sample.png").toDataURL();

window.addEventListener("DOMContentLoaded", async () => {

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  });
  const track = stream.getVideoTracks()[0];
  const video = document.createElement("video");

  let sizeFlag = 0;
  let chronoSpot: CaptureSpot | null = null;
  let leftScoreSpot: CaptureSpot | null = null;
  let rightScoreSpot: CaptureSpot | null = null;
  let matchCodeSpot: CaptureSpot | null = null;
  let homeHintSpot: CheckSpot | null = null;
  let homeIsLeft = true;

  video.onloadedmetadata = () => {
    video.play();

    const sub = defer(async () => {

      if (/*video.videoWidth*/fakeCanvas.width !== sizeFlag || !homeHintSpot?.test(/*video*/fakeCanvas, 0xc0, 0xff, 0xff)) {
        sizeFlag = /*video.videoWidth*/fakeCanvas.width;

        // Init spots
        const canvas = document.createElement("canvas");
        canvas.width = /*video.videoWidth*/fakeCanvas.width;
        canvas.height = 80;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Invalid context");
        ctx.drawImage(fakeCanvas, 0, 0);
        chronoSpot = CaptureSpot.find(ctx, { x: 0, y: 0, width: canvas.width / 3, height: canvas.height }, 0xff, 0xff, 0xff);
        console.log(JSON.stringify(chronoSpot));
        leftScoreSpot = CaptureSpot.find(ctx, { x: canvas.width / 2 - 70, y: 0, width: 70, height: canvas.height }, 0xff, 0xff, 0xff);
        console.log(JSON.stringify(leftScoreSpot));
        rightScoreSpot = CaptureSpot.find(ctx, { x: canvas.width / 2, y: 0, width: 70, height: canvas.height }, 0xff, 0xff, 0xff);
        const matchCodeOffset = Math.round(canvas.width * 0.75);
        matchCodeSpot = CaptureSpot.find(ctx, { x: matchCodeOffset, y: 0, width: canvas.width - matchCodeOffset, height: canvas.height }, 0xff, 0xc0, 0xff);
        homeHintSpot = CheckSpot.find(ctx, { x: 0, y: 0, width: canvas.width, height: canvas.height }, 0xc0, 0xff, 0xff);
        homeIsLeft = (homeHintSpot?.origin.x ?? 0) < canvas.width / 2;
      }

      return {
        chrono: chronoSpot?.capture(/*video*/fakeCanvas),
        homeScore: (homeIsLeft ? leftScoreSpot : rightScoreSpot)?.capture(/*video*/fakeCanvas),
        awayScore: (homeIsLeft ? rightScoreSpot : leftScoreSpot)?.capture(/*video*/fakeCanvas),
        matchCode: matchCodeSpot?.capture(/*video*/fakeCanvas)
      } as CaptureData;
    }).pipe(
      repeat({ delay: 5000 })
    ).subscribe({
      next: (dataUrl) => {
        //console.debug("Data: " + JSON.stringify(dataUrl));
        if (dataUrl.chrono || dataUrl.homeScore || dataUrl.awayScore || dataUrl.matchCode) {
          ipcRenderer.send("capture-data", dataUrl);
        }
      }
    });
  
    track.addEventListener("ended", () => {
      console.debug("Capture track ended");
      sub.unsubscribe();
    });
  
  };
  video.srcObject = stream;
  document.body.append(video);

});

export type CaptureData = Partial<Readonly<{
  chrono: string;
  homeScore: string;
  awayScore: string;
  matchCode: string;
}>>

abstract class Spot {

  protected readonly canvas = document.createElement("canvas");
  protected readonly context = this.canvas.getContext("2d", { willReadFrequently: true });

  constructor(public readonly origin: Point) {}

}

class CaptureSpot extends Spot {

  private contentUrl: string | null = null;

  constructor (origin: Point, size: Size) {
    super(origin);
    this.canvas.width = size.width;
    this.canvas.height = size.height;
  }

  capture(src: CanvasImageSource): string | null {
    this.context?.drawImage(
      src,
      this.origin.x, this.origin.y, this.canvas.width, this.canvas.height,
      0, 0, this.canvas.width, this.canvas.height
    );
    const url = this.canvas.toDataURL();
    if (url != this.contentUrl) {
      this.contentUrl = url;
      return url;
    } else {
      return null;
    }
  }

  static find(ctx: CanvasRenderingContext2D, rect: Rectangle, r: number, g: number, b: number): CaptureSpot | null {
    const data = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    const d = data.data;
    const toPixel = (i: number) => ({ x: (i / 4) % data.width, y: Math.floor(i / 4 / rect.width) }) as Point;
    const matchColor = (i: number) => d[i] == r && d[i + 1] == g && d[i + 2] == b;
    for (let i = 0; i < d?.length; i += 4) {
      if (!matchColor(i)) continue;
      const { x, y } = toPixel(i);
      for (let j = i; j < data.width * (y + 1) * 4; j += 4) {
        if (matchColor(j)) continue;
        if (j - i < 10 * 4) break;
        for (let k = j - 4; k < d.length; k += data.width * 4) {
          if (matchColor(k)) continue;
          const end = toPixel(k);
          if (end.y - y > 10) {
            return new CaptureSpot({ x: x + rect.x, y: y + rect.y }, { width: end.x - x + 1, height: end.y - y });
          } else break;
        }
      }
    }
    console.warn("Capture spot not found");
    return null;
  }

}

class CheckSpot extends Spot {

  test(src: CanvasImageSource, r: number, g: number, b: number): boolean {
    this.context?.drawImage(
      src,
      this.origin.x, this.origin.y, 1, 1,
      0, 0, 1, 1
    );
    const d = this.context?.getImageData(0, 0, 1, 1).data;
    return d?.[0] == r && d[1] == g && d[2] == b;
  }

  static find(ctx: CanvasRenderingContext2D, rect: Rectangle, r: number, g: number, b: number): CheckSpot | null {
    const data = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    const d = data.data;
    const toPixel = (i: number) => ({ x: (i / 4) % data.width, y: Math.floor(i / 4 / rect.width) }) as Point;
    const matchColor = (i: number) => d[i] == r && d[i + 1] == g && d[i + 2] == b;
    for (let i = 0; i < d?.length; i += 4) {
      if (!matchColor(i)) continue;
      const { x, y } = toPixel(i);
      return new CheckSpot({ x: x + rect.x, y: y + rect.y });
    }
    console.warn("Check spot not found");
    return null;
  }

}