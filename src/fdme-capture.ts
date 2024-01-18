import { Point, Rectangle, ipcRenderer } from "electron";
import { nativeImage } from "electron/common";
import { defer, repeat, switchMap, timer } from "rxjs";

type InitContext = { context: CanvasRenderingContext2D, topBarHeight: number };

const initialWindowDelayMs = 5000;
const checkDelayMs = 2000;
const appBackgroundColor = 0xf0f0f0;
const chronoBackgroundColor = 0xffffff;
const chronoStartColor = 0x80ff80;
const chronoStopColor = 0xff0000;
const homeTeamBackgroundColor = 0xc0ffff;
const scoreBackgroundColor = 0xffffff;
const matchCodeBackgroundColor = 0xffc0ff;

const sourceId = location.hash.substring(1);
console.debug(`Configure capture window for '${sourceId}'`);

window.addEventListener("DOMContentLoaded", async () => {

  const stream = sourceId == "@test"
    ? createTestStream()
    : await navigator.mediaDevices.getUserMedia({
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
  let chronoSpot: DataCaptureSpot | null = null;
  let chronoStartedSpot: ColorCheckSpot | null = null;
  let homeScoreSpot: DataCaptureSpot | null = null;
  let awayScoreSpot: DataCaptureSpot | null = null;
  let matchCodeSpot: DataCaptureSpot | null = null;
  let homeHintSpot: ColorCheckSpot | null = null;
  let homeIsLeft: boolean;

  video.onloadedmetadata = () => {
    video.play();

    const check = defer(async () => {

      // Reset all spots on window resized
      if (video.videoWidth !== width || video.videoHeight !== height) {
        width = video.videoWidth;
        height = video.videoHeight;
        console.debug(`Window size: ${width} x ${height}`);
        chronoSpot = matchCodeSpot = homeScoreSpot = awayScoreSpot = homeHintSpot = null;
      }

      const withInitContext = (() => {
        let initCtx: InitContext | undefined;
        return (callback: (ctx: InitContext) => void) => {
          if (!initCtx) {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = 150;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) throw new Error("Invalid context");
            ctx.drawImage(video, 0, 0);
            const topBarHeight = findColorVert(ctx, appBackgroundColor);
            console.log("Top bar height: " + topBarHeight);
            initCtx = { context: ctx, topBarHeight };
          }
          callback(initCtx);
        }
      })();

      if (!chronoSpot) {
        withInitContext(ctx => {
          const chronoRect = findColorRect(ctx, chronoBackgroundColor, 0, 1 / 3);
          console.debug(`Chrono rect: ${JSON.stringify(chronoRect)}`);
          chronoSpot = chronoRect ? new DataCaptureSpot(video, chronoRect) : null;
        });
      }

      if (!chronoStartedSpot) {
        withInitContext((ctx) => {
          const chronoButtonPoint = findColorPoint(ctx, chronoStartColor, 1 / 4, 1 / 4) ?? findColorPoint(ctx, chronoStopColor, 1 / 4, 1 / 4);
          console.debug(`Chrono button point: ${JSON.stringify(chronoButtonPoint)}`);
          chronoStartedSpot = chronoButtonPoint ? new ColorCheckSpot(video, chronoButtonPoint) : null;
        })
      }

      if (!homeHintSpot?.matchColor(homeTeamBackgroundColor)) {
        withInitContext(ctx => {
          const homeHintPoint = findColorPoint(ctx, homeTeamBackgroundColor, 0, 1);
          console.debug(`Home hint point: ${JSON.stringify(homeHintPoint)}`);
          homeHintSpot = homeHintPoint ? new ColorCheckSpot(video, homeHintPoint) : null;
          homeIsLeft = (homeHintPoint?.x ?? 0) < width / 2;
        });
      }

      if (!homeScoreSpot || !awayScoreSpot) {
        withInitContext(ctx => {
          const leftScoreRect = findColorRect(ctx, scoreBackgroundColor, 1 / 3, 1 / 6);
          console.debug(`Left score rect: ${JSON.stringify(leftScoreRect)}`);
          const leftScoreSpot = leftScoreRect ? new DataCaptureSpot(video, leftScoreRect) : null;
          const rightScoreRect = findColorRect(ctx, scoreBackgroundColor, 1 / 2, 1 / 6);
          console.debug(`Right score rect: ${JSON.stringify(rightScoreRect)}`);
          const rightScoreSpot = rightScoreRect ? new DataCaptureSpot(video, rightScoreRect) : null;
          homeScoreSpot = homeIsLeft ? leftScoreSpot : rightScoreSpot;
          awayScoreSpot = homeIsLeft ? rightScoreSpot : leftScoreSpot;
        });
      }

      if (!matchCodeSpot) {
        withInitContext(ctx => {
          const matchCodeRect = findColorRect(ctx, matchCodeBackgroundColor, 3 / 4, 1 / 4);
          console.debug(`Match code rect: ${JSON.stringify(matchCodeRect)}`);
          matchCodeSpot = matchCodeRect ? new DataCaptureSpot(video, matchCodeRect) : null;
        });
      }

      return {
        chrono: chronoSpot?.peekNewData() ?? undefined,
        chronoStarted: chronoStartedSpot?.matchColor(chronoStopColor),
        homeScore: homeScoreSpot?.peekNewData() ?? undefined,
        awayScore: awayScoreSpot?.peekNewData() ?? undefined,
        matchCode: matchCodeSpot?.peekNewData() ?? undefined
      } as CaptureData;

    });
    
    const sub = timer(initialWindowDelayMs).pipe(
      switchMap(() => check.pipe(repeat({ delay: checkDelayMs })))
    ).subscribe({
      next: (dataUrl) => {
        //console.debug("Capture data: " + JSON.stringify(dataUrl, undefined, 2));
        if (dataUrl.chrono || dataUrl.homeScore || dataUrl.awayScore || dataUrl.matchCode) {
          ipcRenderer.send("capture-data:" + sourceId, dataUrl);
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
  chronoStarted: boolean;
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

class DataCaptureSpot extends Spot {

  private contentUrl: string | null = null;

  peekNewData(): string | null {
    this.drawSource();
    const url = this.canvas.toDataURL();
    if (url == this.contentUrl) return null;
    this.contentUrl = url;
    return url;
  }

}

class ColorCheckSpot extends Spot {

  constructor(source: CanvasImageSource, point: Point) {
    super(source, { x: point.x, y: point.y, width: 1, height: 1 });
  }

  matchColor(color: number): boolean {
    this.drawSource();
    const data = this.context?.getImageData(0, 0, 1, 1);
    return !!data && matchColor(data, 0, color);
  }

}

function findColorVert(ctx: CanvasRenderingContext2D, color: number): number {
  const data = ctx.getImageData(5, 0, 1, 100);
  for (let i = 0; i < data.data.length; i += 4) {
    if (matchColor(data, i, color)) return i / 4;
  }
  return 0;
}

function toPoint(data: ImageData, i: number): Point {
  return { x: (i / 4) % data.width, y: Math.floor(i / 4 / data.width) };
}

function matchColor(data: ImageData, i: number, color: number): boolean {
  return [(color >> 0x10) & 0xff, (color >> 0x8) & 0xff, color & 0xff]
    .every((c, o) => Math.abs(data.data[i + o] - c) < 5);
}

function findColorRect(
  ctx: InitContext,
  color: number,
  xMinRatio: number,
  widthRatio: number,
  minSize = 10
): Rectangle | null {
  const rect = {
    x: Math.round(ctx.context.canvas.width * xMinRatio),
    y: ctx.topBarHeight,
    width: Math.round(ctx.context.canvas.width * widthRatio),
    height: ctx.context.canvas.height - ctx.topBarHeight
  }
  const data = ctx.context.getImageData(rect.x, rect.y, rect.width, rect.height);
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
  ctx: InitContext,
  color: number,
  xMinRatio: number,
  widthRatio: number
): Point | null {
  const rect = {
    x: Math.round(ctx.context.canvas.width * xMinRatio),
    y: ctx.topBarHeight,
    width: Math.round(ctx.context.canvas.width * widthRatio),
    height: ctx.context.canvas.height - ctx.topBarHeight
  }
  const data = ctx.context.getImageData(rect.x, rect.y, rect.width, rect.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!matchColor(data, i, color)) continue;
    const pt = toPoint(data, i);
    return { x: rect.x + pt.x, y: rect.y + pt.y };
  }
  return null;
}

function createTestStream() {
  const canvas = document.createElement("canvas");
  const img = new Image();
  img.onload = () => {
    canvas.height = img.height;
    canvas.width = img.width;
    canvas.getContext("2d", { willReadFrequently: true })?.drawImage(img, 0, 0);
  };
  img.src = nativeImage.createFromPath("assets/fdme-test.png").toDataURL();
  return canvas.captureStream();
}