import { Point, Rectangle, ipcRenderer } from "electron";
import { defer, repeat } from "rxjs";

const sourceId = location.hash.substring(1);
console.debug(`Configure capture window for '${sourceId}'`);

/*const fakeCanvas = document.createElement("canvas");
const img = new Image();
img.onload = () => {
  fakeCanvas.height = Math.min(img.height, 80);
  fakeCanvas.width = img.width;
  fakeCanvas.getContext("2d", { willReadFrequently: true })?.drawImage(img, 0, 0);
};
img.src = nativeImage.createFromPath("assets/sample.png").toDataURL();*/

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

  let width = 0;
  let height = 0;
  let chronoSpot: CaptureSpot | null = null;
  let homeScoreSpot: CaptureSpot | null = null;
  let awayScoreSpot: CaptureSpot | null = null;
  let matchCodeSpot: CaptureSpot | null = null;
  let homeHintSpot: CheckSpot | null = null;

  video.onloadedmetadata = () => {
    video.play();

    const sub = defer(async () => {

      if (video.videoWidth !== width || video.videoHeight !== height || !homeHintSpot?.check()) {

        width = video.videoWidth;
        height = video.videoHeight;
        console.debug(`Window size: ${width} x ${height}`);

        // Init spots
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = 150;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Invalid context");
        ctx.drawImage(video, 0, 0);

        // Top bar offset
        const topBarHeight = getTopBarHeight(ctx);
        console.log("Top bar height: " + topBarHeight);

        const homeHintPoint = findColorPoint(ctx, {
          x: 0,
          y: topBarHeight,
          width: width,
          height: canvas.height - topBarHeight
        }, [ 0xc0, 0xff, 0xff ]);
        console.debug(`Home hint point: ${JSON.stringify(homeHintPoint)}`);
        homeHintSpot = homeHintPoint ? new CheckSpot(video, homeHintPoint, [ 0xc0, 0xff, 0xff ]) : null;
        const homeIsLeft = (homeHintPoint?.x ?? 0) < width / 2;

        const chronoRect = findColorRect(ctx, {
          x: 0,
          y: topBarHeight,
          width: Math.round(width / 3),
          height: canvas.height - topBarHeight
        }, [ 0xff, 0xff, 0xff ]);
        console.debug(`Chrono rect: ${JSON.stringify(chronoRect)}`);
        chronoSpot = chronoRect ? new CaptureSpot(video, chronoRect) : null;

        const leftScoreRect = findColorRect(ctx, {
          x: Math.round(width / 3),
          y: topBarHeight,
          width: Math.round(width / 6),
          height: canvas.height - topBarHeight
        }, [ 0xff, 0xff, 0xff ]);
        console.debug(`Left score rect: ${JSON.stringify(leftScoreRect)}`);
        const leftScoreSpot = leftScoreRect ? new CaptureSpot(video, leftScoreRect) : null;

        const rightScoreRect = findColorRect(ctx, {
          x: Math.round(width / 2),
          y: topBarHeight,
          width: Math.round(width / 6),
          height: canvas.height - topBarHeight
        }, [ 0xff, 0xff, 0xff ]);
        console.debug(`Right score rect: ${JSON.stringify(rightScoreRect)}`);
        const rightScoreSpot = rightScoreRect ? new CaptureSpot(video, rightScoreRect) : null;

        homeScoreSpot = homeIsLeft ? leftScoreSpot : rightScoreSpot;
        awayScoreSpot = homeIsLeft ? rightScoreSpot : leftScoreSpot;

        const matchCodeRect = findColorRect(ctx, {
          x: Math.round(width * 0.75),
          y: topBarHeight,
          width: Math.round(width * 0.25),
          height: canvas.height - topBarHeight
        }, [ 0xff, 0xc0, 0xff ]);
        console.debug(`Match code score: ${JSON.stringify(matchCodeRect)}`);
        matchCodeSpot = matchCodeRect ? new CaptureSpot(video, matchCodeRect) : null;

      }

      return {
        chrono: chronoSpot?.checkData(),
        homeScore: homeScoreSpot?.checkData(),
        awayScore: awayScoreSpot?.checkData(),
        matchCode: matchCodeSpot?.checkData()
      } as CaptureData;
    }).pipe(
      repeat({ delay: 5000 })
    ).subscribe({
      next: (dataUrl) => {
        //console.debug("Data: " + JSON.stringify(dataUrl, undefined, 2));
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

  constructor(protected source: CanvasImageSource, protected rect: Rectangle) {
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  protected drawSource() {
    this.context?.drawImage(
      this.source,
      this.rect.x, this.rect.y, this.rect.width, this.rect.height,
      0, 0, this.canvas.width, this.canvas.height
    );
  }

}

class CaptureSpot extends Spot {

  private contentUrl: string | null = null;

  checkData(): string | null {
    this.drawSource();
    const url = this.canvas.toDataURL();
    if (url == this.contentUrl) return null;
    this.contentUrl = url;
    return url;
  }

}

class CheckSpot extends Spot {

  constructor(source: CanvasImageSource, point: Point, private readonly color: [ number, number, number ]) {
    super(source, { x: point.x, y: point.y, width: 1, height: 1});
  }

  check(): boolean {
    this.drawSource();
    const data = this.context?.getImageData(0, 0, 1, 1);
    return !!data && matchColor(data, 0, this.color);
  }

}

function getTopBarHeight(ctx: CanvasRenderingContext2D): number {
  const data = ctx.getImageData(5, 0, 1, 100);
  for (let i = 0; i < data.data.length; i += 4) {
    if (matchColor(data, i, [ 0xf0, 0xf0, 0xf0 ])) return i / 4;
  }
  return 0;
}

function toPoint(data: ImageData, i: number): Point {
  return { x: (i / 4) % data.width, y: Math.floor(i / 4 / data.width) };
}

function matchColor(data: ImageData, i: number, color: [ number, number, number ]): boolean {
  return color.every((c, o) => Math.abs(data.data[i + o] - c) < 5);
}

function findColorRect(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  color: [ number, number, number ],
  minSize = 10
): Rectangle | null {
  const data = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!matchColor(data, i, color)) continue;
    const start = toPoint(data, i);
    for (let j = i; j < data.width * (start.y + 1) * 4; j += 4) {
      if (matchColor(data, j, color)) continue;
      if (j - i < minSize * 4) break;
      for (let k = j - 4; k < d.length; k += data.width * 4) {
        if (matchColor(data, k, color)) continue;
        const end = toPoint(data, k);
        if (end.y - start.y >= minSize) {
          return {
            x: rect.x + start.x,
            y: rect.y + start.y,
            width: end.x - start.x + 1,
            height: end.y - start.y
          };
        } else break;
      }
    }
  }
  return null;
}

function findColorPoint(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  color: [ number, number, number ]
): Point | null {
  const data = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!matchColor(data, i, color)) continue;
    const pt = toPoint(data, i);
    return { x: rect.x + pt.x, y: rect.y + pt.y };
  }
  return null;
}