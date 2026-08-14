import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../agent/channels/photon-alert-app.ts", import.meta.url), "utf8");
assert.match(source, /location\.hash\.slice\(1\)/u);
assert.match(source, /applyPhotonAlertDiscussAction/u);
assert.match(source, /Eve will wait for your next message/u);
assert.equal(source.includes("bridge.send"), false);
assert.equal(source.includes("location.search"), false);
assert.equal(source.includes("console."), false);

console.info("Photon alert action app verification passed.");
