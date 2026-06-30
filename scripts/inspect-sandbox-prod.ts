console.log("Env variables:");
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("REDIS") || k.startsWith("KV") || k.startsWith("VERCEL") || k.startsWith("ADMIN")) {
    console.log(`${k}=${v ? (v.length > 20 ? v.substring(0, 20) + '...' : v) : ''}`);
  }
}
