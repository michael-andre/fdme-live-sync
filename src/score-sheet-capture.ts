import { Point, Rectangle, ipcRenderer } from "electron";
import { nativeImage } from "electron/common";
import { Observable, concatMap, defer, repeat, switchMap, timer } from "rxjs";

const windowResizeDelayMs = 5000;
const checkDelayMs = 2000;
const chronoBackgroundColor = 0xffffff;
const chronoStartColor = 0x80ff80;
const chronoStopColor = 0xff0000;
const homeTeamBackgroundColor = 0xc0ffff;
const scoreBackgroundColor = 0xffffff;

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
        },
        cursor: "never"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
    });
  const track = stream.getVideoTracks()[0];
  const video = document.createElement("video");

  video.onloadedmetadata = () => {
    video.play();

    const sub = new Observable(sub => {
      const listener = () => sub.next();
      listener();
      video.addEventListener("resize", listener);
      return () => video.removeEventListener("resize", listener);
    }).pipe(
      switchMap(() => timer(windowResizeDelayMs).pipe(
        concatMap(() => observeVideoSpots(video))
      ))
    ).subscribe({
      next: (dataUrl) => {
        //console.debug("Capture data: " + JSON.stringify(dataUrl, undefined, 2));
        if (dataUrl.chrono || dataUrl.homeScore || dataUrl.awayScore) {
          ipcRenderer.send("capture-data:" + sourceId, dataUrl);
        }
      },
      error: (e) => {
        console.error("FDME capture error");
        console.error(e);
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

function observeVideoSpots(video: HTMLVideoElement): Observable<CaptureData> {
  console.debug(`Window size: ${video.videoWidth} x ${video.videoHeight}`);
  let homeRect: Rectangle | null;
  let chronoSpot: DataCaptureSpot | null = null;
  let chronoStartedSpot: ColorCheckSpot | null = null;
  let homeScoreSpot: DataCaptureSpot | null = null;
  let awayScoreSpot: DataCaptureSpot | null = null;
  let homeHintSpot: ColorCheckSpot | null = null;
  let homeIsLeft: boolean;
  let chronoStarted: boolean | undefined;
  return defer(async () => {

    const requireInitContext = (() => {
      let initCtx: CanvasRenderingContext2D | undefined;
      return (): CanvasRenderingContext2D => {
        if (!initCtx) {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = 150;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("Invalid context");
          ctx.drawImage(video, 0, 0);
          homeRect = findColorRect(ctx, homeTeamBackgroundColor, 0, 1, 0);
          console.debug("Top bar height: " + homeRect?.y);
          initCtx = ctx;
        }
        return initCtx;
      }
    })();

    if (!homeHintSpot) {
      requireInitContext();
      console.debug(`Home hint rect: ${JSON.stringify(homeRect)}`);
      homeHintSpot = homeRect ? new ColorCheckSpot(video, homeRect) : null;
      homeIsLeft = (homeRect?.x ?? 0) < video.videoWidth / 2;
    }
    if (!homeRect) return {};

    if (!chronoSpot) {
      const ctx = requireInitContext();
      const chronoRect = findColorRect(ctx, chronoBackgroundColor, 0, 1 / 3, homeRect.y);
      console.debug(`Chrono rect: ${JSON.stringify(chronoRect)}`);
      chronoSpot = chronoRect ? new DataCaptureSpot(video, chronoRect) : null;
    }

    if (!chronoStartedSpot) {
      const ctx = requireInitContext();
      const chronoButtonRect = findColorRect(ctx, chronoStartColor, 1 / 4, 1 / 4, homeRect.y)
        ?? findColorRect(ctx, chronoStopColor, 1 / 4, 1 / 4, homeRect.y);
      console.debug(`Chrono button rect: ${JSON.stringify(chronoButtonRect)}`);
      chronoStartedSpot = chronoButtonRect ? new ColorCheckSpot(video, chronoButtonRect) : null;
    }

    if (!homeScoreSpot || !awayScoreSpot) {
      const ctx = requireInitContext();
      const leftScoreRect = findColorRect(ctx, scoreBackgroundColor, 1 / 3, 1 / 6, homeRect.y);
      console.debug(`Left score rect: ${JSON.stringify(leftScoreRect)}`);
      const leftScoreSpot = leftScoreRect ? new DataCaptureSpot(video, leftScoreRect) : null;
      const rightScoreRect = findColorRect(ctx, scoreBackgroundColor, 1 / 2, 1 / 6, homeRect.y);
      console.debug(`Right score rect: ${JSON.stringify(rightScoreRect)}`);
      const rightScoreSpot = rightScoreRect ? new DataCaptureSpot(video, rightScoreRect) : null;
      homeScoreSpot = homeIsLeft ? leftScoreSpot : rightScoreSpot;
      awayScoreSpot = homeIsLeft ? rightScoreSpot : leftScoreSpot;
    }

    const newChronoStarted = chronoStartedSpot?.matchColor(chronoStopColor);
    const reportChronoStarted = newChronoStarted !== chronoStarted;
    chronoStarted = newChronoStarted;
    return {
      chrono: chronoSpot?.peekNewData() ?? undefined,
      chronoStarted: reportChronoStarted ? chronoStarted : undefined,
      homeScore: homeScoreSpot?.peekNewData() ?? undefined,
      awayScore: awayScoreSpot?.peekNewData() ?? undefined
    } as CaptureData;

  }).pipe(repeat({ delay: checkDelayMs }));
}

export type CaptureData = Partial<Readonly<{
  chrono: string;
  chronoStarted: boolean;
  homeScore: string;
  awayScore: string;
}>>

abstract class Spot {

  protected readonly context = document.createElement("canvas")
    .getContext("2d", { willReadFrequently: true })!;

  constructor(protected source: CanvasImageSource, protected rect: Rectangle) {
    this.context.canvas.width = rect.width;
    this.context.canvas.height = rect.height;
    this.context.imageSmoothingEnabled = false;
  }

  protected drawSource() {
    this.context?.drawImage(
      this.source,
      this.rect.x, this.rect.y, this.rect.width, this.rect.height,
      0, 0, this.context.canvas.width, this.context.canvas.height
    );
  }

}

class DataCaptureSpot extends Spot {

  private contentUrl: string | null = null;

  peekNewData(): string | null {
    this.drawSource();
    const url = this.context.canvas.toDataURL();
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

function toPoint(data: ImageData, i: number): Point {
  return { x: (i / 4) % data.width, y: Math.floor(i / 4 / data.width) };
}

function matchColor(data: ImageData, i: number, color: number): boolean {
  return [(color >> 0x10) & 0xff, (color >> 0x8) & 0xff, color & 0xff]
    .every((c, o) => Math.abs(data.data[i + o] - c) < 5);
}

function findColorRect(
  ctx: CanvasRenderingContext2D,
  color: number,
  xMinRatio: number,
  widthRatio: number,
  yOffset: number,
  minSize = 10
): Rectangle | null {
  const rect = {
    x: Math.round(ctx.canvas.width * xMinRatio),
    y: yOffset,
    width: Math.round(ctx.canvas.width * widthRatio),
    height: ctx.canvas.height - yOffset
  }
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

function createTestStream(): MediaStream {
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