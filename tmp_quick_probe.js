(async()=>{
  const s=require('/opt/billing-rtrw/services/mikrotikService');
  try { const a=await s.getPppoeSecrets(); console.log('secrets', Array.isArray(a)?a.length:'x'); } catch(e){ console.log('secrets_err', e.message); }
  try { const a=await s.getPppoeActive(); console.log('active', Array.isArray(a)?a.length:'x'); } catch(e){ console.log('active_err', e.message); }
  try { const a=await s.getMonitoringSummary(); console.log('summary', JSON.stringify(a)); } catch(e){ console.log('summary_err', e.message); }
})().catch((e)=>{ console.error(e); process.exit(1); });
