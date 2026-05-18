(async()=>{
  const s=require('/opt/billing-rtrw/services/mikrotikService');
  const names=['getPppoeSecrets','getPppoeActive','getHotspotUsers','getHotspotActive','getMonitoringSummary'];
  for (const n of names){
    try{
      const r=await s[n]();
      console.log('FN',n,'TYPE',Array.isArray(r)?'array':typeof r,'LEN',Array.isArray(r)?r.length:0);
      if (!Array.isArray(r)) console.log('VAL',JSON.stringify(r));
    }catch(e){
      console.log('ERR',n,e&&e.message);
    }
  }
  process.exit(0);
})().catch((e)=>{ console.error('FATAL', e && e.stack || e); process.exit(1); });
