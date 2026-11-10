import http from "node:http";
import { SHARE_PEER_HEADER, sharePeerDecision } from "./share-peer.mjs";

export { SHARE_PEER_HEADER, isPrivateSharePeer, sharePeerDecision } from "./share-peer.mjs";

const INSTALLED = Symbol.for("nema.sharePeerGuard");

/** Reject a public or forwarded /s request before Next or the hub sees it, and pin the peer header to the socket. */
export function installSharePeerGuard() {
  const proto = http.Server.prototype;
  if (proto[INSTALLED]) return;
  const emit = proto.emit;
  proto.emit = function (event, req, res, ...rest) {
    if (event === "request" && req && res) {
      if (req.headers) delete req.headers[SHARE_PEER_HEADER];
      const path = String(req.url ?? "").split("?")[0];
      if (path === "/s" || path.startsWith("/s/")) {
        if (sharePeerDecision(req.socket?.remoteAddress, req.headers ?? {}) === "reject") {
          req.resume();
          const body = "not found";
          res.writeHead(404, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store",
          });
          res.end(body);
          return true;
        }
        const peer = req.socket?.remoteAddress;
        if (req.headers && peer) req.headers[SHARE_PEER_HEADER] = peer;
      }
    }
    return emit.call(this, event, req, res, ...rest);
  };
  proto[INSTALLED] = true;
}

installSharePeerGuard();
