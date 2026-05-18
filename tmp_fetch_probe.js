(async()=>{
  const key='billing-local-api-2026-Q4r7N2x9P6m1L8s5';
  for (const url of [
    'http://127.0.0.1:3001/admin/api/mikrotik/summary',
    'http://127.0.0.1:3001/admin/api/mikrotik/secrets?page=1&limit=3'
  ]) {
    const res = await fetch(url, { headers: { 'x-admin-key': key, 'accept':'application/json' } });
    const text = await res.text();
    console.log('URL', url);
    console.log('STATUS', res.status);
    console.log(text.slice(0, 1200));
    console.log('---');
  }
})().catch((e)=>{ console.error(e); process.exit(1); });
