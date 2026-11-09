import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  old = path.resolve(
    process.argv[2] || path.resolve(root, "../qingyi-extension"),
  ),
  newId = (
    await fs.readFile(path.join(root, "extension-id.txt"), "utf8")
  ).trim();
const manifest = JSON.parse(await fs.readFile(old + "/manifest.json", "utf8"));
manifest.externally_connectable = { ids: [newId] };
await fs.writeFile(old + "/manifest.json", JSON.stringify(manifest, null, 2));
let background = await fs.readFile(old + "/background.js", "utf8");
if (!background.includes("case 'MIGRATION_ENABLE':"))
  background = background.replace(
    "case 'PUBLIC': {",
    `case 'MIGRATION_ENABLE': {assert(trusted,'请在旧版设置页操作。');const bytes=crypto.getRandomValues(new Uint32Array(1)),code=String(100000+bytes[0]%900000);await chrome.storage.session.set({'migration.once':{code,expires:Date.now()+600000,target:'${newId}'}});return {code};}\n    case 'PUBLIC': {`,
  );
if (!background.includes("QINGYI_MIGRATE"))
  background += `\nchrome.runtime.onMessageExternal.addListener((message,sender,respond)=>{if(sender.id!=='${newId}')return;void(async()=>{const state=(await chrome.storage.session.get('migration.once'))['migration.once'];assert(state&&state.target===sender.id&&state.expires>Date.now()&&state.code===message.code,'迁移验证码无效或已过期。');if(message.type==='QINGYI_MIGRATED'){await chrome.storage.session.remove('migration.once');return {completed:true};}assert(message.type==='QINGYI_MIGRATE','无效迁移请求。');const data=await chrome.storage.local.get(null),c=await config(),sites=data.sites||{},caches=[];for(const key of (data['cache:recent']||[])){if(!key.startsWith('cache:')||!Array.isArray(data[key]))continue;let origin=null;for(const site of Object.keys(sites))if(key==='cache:'+await digest(JSON.stringify([site,c.apiUrl,c.model,'prompt.v2'])))origin=site;caches.push({key,origin,entries:data[key]});}return{config:c,sites,progressVisible:data['ui.progressVisible']!==false,position:data['ui.position']||{x:.78,y:.9},caches};})().then(data=>respond({ok:true,data}),()=>respond({ok:false,error:'MIGRATION_REFUSED'}));return true;});\n`;
await fs.writeFile(old + "/background.js", background);
let html = await fs.readFile(old + "/options.html", "utf8");
if (!html.includes("migration-enable"))
  html = html.replace(
    "<footer>",
    `<section class="card"><h2>迁移到轻译 3.0</h2><p class="hint">只允许固定新扩展接收配置。点击生成 10 分钟有效的一次性验证码，随后在新版设置输入。Key 仅通过扩展消息传递。</p><button id="migration-enable">启用一次性迁移</button><p id="migration-code" role="status"></p></section><footer>`,
  );
await fs.writeFile(old + "/options.html", html);
let options = await fs.readFile(old + "/options.js", "utf8");
if (!options.includes("migration-enable"))
  options += `\n$('migration-enable').addEventListener('click',async()=>{try{const r=await send('MIGRATION_ENABLE');$('migration-code').textContent='迁移验证码：'+r.code+'（10 分钟有效）';}catch(e){$('migration-code').textContent=e.message;}});\n`;
await fs.writeFile(old + "/options.js", options);
console.log("Prepared bridge for " + newId);
