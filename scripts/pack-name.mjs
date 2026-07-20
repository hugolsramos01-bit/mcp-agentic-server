let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const packed = JSON.parse(input);
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not return an artifact filename");
  process.stdout.write(filename);
});
