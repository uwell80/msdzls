import { encryptFrame } from "./frame-codec.mjs";
for (const n of [0,1,4,7,8,9,10,15,16,17,64]) {
  const { out, nTotalLength, outCursor } = encryptFrame(Buffer.alloc(n, 0x11), Buffer.from("0123456789abcdef"));
  console.log(`plain=${String(n).padStart(3)}  nTotal=${String(nTotalLength).padStart(3)}  outCursor=${String(outCursor).padStart(3)}  blocks=${outCursor/8}`);
}
