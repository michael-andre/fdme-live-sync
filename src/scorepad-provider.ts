import * as net from "net";
import * as os from "os";
import { Observable, distinctUntilChanged, map, mergeMap, retry, scan, share, tap, timer } from "rxjs";
import { MatchUpdate } from "./main";
import { entries, isEqual, merge } from "lodash";

const scorepadServerPort = 4001;
const serverRetryDelayMs = 10000;
const errorRetryDelay = 5000;

/**
 * Start a local TCP server for Scorepad connection and parse received data.
 * @param host Local IP host to listen to
 * @returns A shared stream of updates
 */
export function observeScorepadUpdates(): Observable<MatchUpdate> {
  return startScorepadServer().pipe(
    map(frame => processScorepadMessage(frame) ?? {}),
    // Accumulate messages
    scan((state, update) => merge({}, state, update), {} as MatchUpdate),
    distinctUntilChanged(isEqual),
    tap(u => {
      console.debug(`Scorepad update: ${JSON.stringify(u)}`);
    }),
    // Auto-retry on error
    retry({ delay: (e) => {
      console.error(`Scorepad updates error: ${e}`);
      return timer(errorRetryDelay);
    }}),
    share()
  )
}

function findLocalEthernetHost(): string | null {
  return entries(os.networkInterfaces())
    .find(([k]) => k.startsWith("eth"))
    ?.[1]
    ?.find(i => i.family == "IPv4")
    ?.address
  ?? null;
}

function startScorepadServer(): Observable<Buffer> {
  return new Observable<net.Socket>(sub => {
    const host = findLocalEthernetHost();
    if (!host) throw Error("Local wired network interface not found");
    console.debug(`Network interface: ${host}`);
    const server = net.createServer();
    server.on("connection", (socket) => {
      console.log(`Scorepad client connected from ${socket.remoteAddress}:${socket.remotePort}`);
      sub.next(socket);
    });
    server.on("error", e => {
      console.warn(`Scorepad server error: ${e}`);
      sub.error(e);
    });
    server.listen(scorepadServerPort, host, () => {
      console.log("Scorepad server started");
    });
    return () => {
      try {
        server.close(() => console.debug("Scorepad server closed"));
        server.unref();  
      } catch (e) {
        console.error(`Failed to close server: ${e}`);
      }
    };
  }).pipe(
    retry({ delay: serverRetryDelayMs }),
    mergeMap(connection => new Observable<Buffer>(sub => {
      connection.on("data", (frame) => sub.next(frame));
      connection.on("close", () => sub.complete());
      connection.on("error", e => {
        console.warn(`Scorepad connection error: ${e}`);
        sub.error(e);
      });
      return () => {
        try {
          connection.destroy();
          connection.unref();
        } catch (e) {
          console.error(`Failed to close connection: ${e}`);
        }
      };
    }).pipe(
      retry({ delay: serverRetryDelayMs })
    ))
  );
}

/**
 * Parse a data frame to extract chrono and score information.
 * https://static.bodet-sport.com/images/stories/EN/support/Pdfs/manuals/Scorepad/608264-Network%20output%20and%20protocols-Scorepad.pdf
 * @param frame A raw frame for Scorepad connection
 * @returns Parsed MatchUpdate with chrono and score
 */
function processScorepadMessage(frame: Buffer): MatchUpdate | null {
  // Omit frame prefix (SOH / Address / STX / CTRL) and suffix (ETX / LRC)
  const msg = frame.subarray(4, -2);
  if (msg[0] == 0x30 && msg[1] == 0x31 && msg[3] == 0x34) {
    // Handball / Message 01: game clock

    const clockStatus = msg[2];
    // Type of clock from bit 0 of clock status byte
    const isGameClock = ((clockStatus >>> 0) & 0x01) == 0;
    if (!isGameClock) return null;
    // Game clock status from bit 1 of clock status byte
    const chronoStarted = ((clockStatus >>> 1) & 0x01) == 0;

    // Chrono
    const min = Number(String.fromCharCode(msg[4])) * 10 + Number(String.fromCharCode(msg[5]));
    const sec = Number(String.fromCharCode(msg[6])) * 10 + Number(String.fromCharCode(msg[7]));
    const chrono = min * 60 + sec;
    const period = Number(String.fromCharCode(msg[10]));
    if (isNaN(chrono)) {
      console.warn("Invalid Scorepad frame for chrono");
      return null;
    }

    return { chrono, chronoStarted, period: isNaN(period) ? undefined : period };

  } else if (msg[0] == 0x30 && msg[1] == 0x32 && msg[2] == 0x34) {
    // Handball / Message 02: scores

    const homeScore = Number((
      String.fromCharCode(msg[3])
      + String.fromCharCode(msg[4])
      + String.fromCharCode(msg[5])
    ).trim());
    const awayScore = Number((
      String.fromCharCode(msg[6])
      + String.fromCharCode(msg[7])
      + String.fromCharCode(msg[8])
    ).trim());
    if (isNaN(homeScore) || isNaN(awayScore)) {
      console.warn("Invalid Scorepad frame for score");
      return null;
    }

    return { homeScore, awayScore };

  }
  return null;
}
