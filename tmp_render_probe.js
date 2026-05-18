(async()=>{
  const s=require('/opt/billing-rtrw/services/mikrotikService');
  const secrets=await s.getPppoeSecrets();
  const active=await s.getPppoeActive();
  const activeByName=new Map(active.map((x)=>[String(x?.name||''),x]));
  const sample=secrets.slice(0,5).map((secret)=>({
    id: secret['.id'] || secret.id,
    name: secret.name,
    profile: secret.profile,
    remoteAddress: secret.remoteAddress || secret['remote-address'] || '-',
    sessionRemoteAddress: activeByName.get(String(secret?.name||''))?.address || null,
    sessionUptime: activeByName.get(String(secret?.name||''))?.uptime || null,
    displayStatus: activeByName.has(String(secret?.name||'')) ? 'online' : ((secret?.disabled===true || secret?.disabled==='true') ? 'disabled' : 'offline')
  }));
  console.log(JSON.stringify({ secrets: secrets.length, active: active.length, sample }, null, 2));
})().catch((e)=>{ console.error(e); process.exit(1); });
