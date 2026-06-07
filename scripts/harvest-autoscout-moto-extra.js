const { chromium } = require('playwright');
const path=require('path');
const { resolveChromiumExecutable } = require('./backend/scrapers/utils');
const PW=path.join(__dirname,'pw-browsers'); process.env.PLAYWRIGHT_BROWSERS_PATH=PW;
const norm=s=>String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
const STOP=/\b(motorcycles|motorcycle|motor|italia|racing|moto|brp)\b/gi;
function slugs(name){
  const base=name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const full=base.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const noStop=base.replace(STOP,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const first=base.split(/[^a-z0-9]+/).filter(Boolean)[0]||full;
  return [...new Set([full,noStop,first].filter(Boolean))];
}
const BRANDS=["Benda Motorcycles","Betamotor","Brixton Motorcycles","Can-Am Brp","Fantic Motor","FB Mondial","Keeway Motor","Kl","Mash Italia","Morbidelli","Talaria Moto","Tm Moto","Valenti Racing","Zero"];
(async()=>{
  const b=await chromium.launch({executablePath:resolveChromiumExecutable(PW),headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled']});
  const ctx=await b.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',locale:'it-IT'});
  await ctx.addInitScript(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>false});window.chrome={runtime:{}};});
  const p=await ctx.newPage();
  const out=[];
  for(const brand of BRANDS){
    let res={brand,makeId:null,slug:null,makeName:null};
    for(const s of slugs(brand)){
      try{
        const r=await p.goto(`https://www.autoscout24.it/lst/${s}?atype=B&cy=I`,{waitUntil:'domcontentloaded',timeout:30000});
        if(!r||r.status()>=400) continue;
        await p.waitForTimeout(900);
        const nd=await p.$eval('#__NEXT_DATA__',e=>e.textContent).catch(()=>'');
        const mid=(nd.match(/"makeId":\s*(\d+)/)||[])[1];
        const veh=(nd.match(/"make":"([^"]+)"/)||[])[1]||null;
        if(mid && veh && (norm(brand).includes(norm(veh))||norm(veh).includes(norm(brand).slice(0,5)))){
          res={brand,makeId:Number(mid),slug:s,makeName:veh}; break;
        }
        if(mid && !res.makeId){ res={brand,makeId:Number(mid),slug:s,makeName:veh,unverified:true}; }
      }catch(_){}
    }
    out.push(res); console.log(JSON.stringify(res));
  }
  require('fs').writeFileSync('/tmp/as24_14.json',JSON.stringify(out,null,2));
  await b.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
