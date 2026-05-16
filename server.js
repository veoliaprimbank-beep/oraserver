const express = require('express');
const cors = require('cors');
const RSSParser = require('rss-parser');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ANTHROPIC (lazy load) ──
let anthropic = null;
function getAI() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Googlebot/2.1 (+http://www.google.com/bot.html)',
];
const rndUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const SOURCES = [
  { id:'noi',       name:'Noi.md',        url:'https://noi.md/rss/ru',             cat:'Общество',  lang:'ru' },
  { id:'point',     name:'Point.md',      url:'https://point.md/rss.php',          cat:'Политика',  lang:'ru' },
  { id:'newsmaker', name:'NewsMaker.md',  url:'https://newsmaker.md/ru/rss',       cat:'Общество',  lang:'ru' },
  { id:'moldova1',  name:'Moldova1.md',   url:'https://moldova1.md/rss',           cat:'Общество',  lang:'ro' },
  { id:'nokta',     name:'Nokta.md',      url:'https://nokta.md/feed',             cat:'Общество',  lang:'ru' },
  { id:'deschide',  name:'Deschide.md',   url:'https://deschide.md/rss',           cat:'Политика',  lang:'ro' },
  { id:'eved',      name:'eVedomosti.md', url:'http://www.evedomosti.md/rss.php',  cat:'Политика',  lang:'ru' },
  { id:'nbm',       name:'НБМ',           url:'https://www.bnm.md/ro/content/rss', cat:'Экономика', lang:'ro' },{ id:'unimedia',  name:'Unimedia.md',   url:'https://unimedia.info/feed/',        cat:'Политика',  lang:'ro' },
  { id:'stiri',     name:'Stiri.md',      url:'https://stiri.md/feed',              cat:'Общество',  lang:'ro' },
  { id:'ziua',      name:'Ziua.md',       url:'https://ziua.md/feed/',              cat:'Общество',  lang:'ro' },
  { id:'moldova',   name:'Moldova.org',   url:'https://www.moldova.org/feed/',      cat:'Общество',  lang:'ro' },
  { id:'locals',    name:'Locals.md',     url:'https://locals.md/feed',             cat:'Общество',  lang:'ro' },
  
];

let cache = {
  articles: [],
  lastUpdate: null,
  sourceStatus: {},
  stats: { total:0, ok:0, failed:0 },
  digest: null,
  trends: [],
  agentStats: {
    editor:     { processed:0, lastRun:null, status:'idle' },
    translator: { processed:0, lastRun:null, status:'idle' },
    summarizer: { processed:0, lastRun:null, status:'idle' },
    trends:     { processed:0, lastRun:null, status:'idle' },
    digest:     { processed:0, lastRun:null, status:'idle' },
  }
};

// ════════════════════════════════════════
// 🤖 AI АГЕНТЫ
// ════════════════════════════════════════

async function callAI(prompt, maxTokens=1000) {
  const ai = getAI();
  if (!ai) throw new Error('API ключ не задан');
  const msg = await ai.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role:'user', content: prompt }],
  });
  return msg.content[0].text.trim();
}

function parseJSON(text) {
  return JSON.parse(text.replace(/```json|```/g,'').trim());
}

// Агент 1: Редактор заголовков
async function agentEditor(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return articles;
  const toProcess = articles.filter(a => !a.aiTitle).slice(0, 15);
  if (!toProcess.length) return articles;
  cache.agentStats.editor.status = 'running';
  console.log(`[АГЕНТ-РЕДАКТОР] Улучшаю ${toProcess.length} заголовков...`);
  try {
    const list = toProcess.map((a,i) => `${i+1}. [${a.category}] ${a.title}`).join('\n');
    const text = await callAI(
      `Ты редактор молдавского новостного сайта ORA.MD. Сделай заголовки интереснее и кликабельнее для русскоязычных читателей Молдовы. Сохрани суть но добавь интригу. Отвечай ТОЛЬКО JSON массивом строк без пояснений.\n\nЗаголовки:\n${list}\n\nJSON массив ${toProcess.length} строк:`
    );
    const improved = parseJSON(text);
    toProcess.forEach((a,i) => {
      if (improved[i]) {
        const idx = articles.findIndex(x => x.id === a.id);
        if (idx !== -1) articles[idx].aiTitle = improved[i];
      }
    });
    cache.agentStats.editor.processed += toProcess.length;
    cache.agentStats.editor.lastRun = new Date();
    cache.agentStats.editor.status = 'ok';
    console.log(`[АГЕНТ-РЕДАКТОР] ✓ Улучшено ${toProcess.length} заголовков`);
  } catch(e) {
    cache.agentStats.editor.status = 'error';
    console.log(`[АГЕНТ-РЕДАКТОР] ✗ ${e.message}`);
  }
  return articles;
}

// Агент 2: Переводчик RO → RU
async function agentTranslator(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return articles;
  const toTranslate = articles.filter(a => a.lang === 'ro' && !a.translated).slice(0, 10);
  if (!toTranslate.length) return articles;
  cache.agentStats.translator.status = 'running';
  console.log(`[АГЕНТ-ПЕРЕВОДЧИК] Перевожу ${toTranslate.length} статей...`);
  try {
    const texts = toTranslate.map((a,i) => `${i+1}. ЗАГОЛОВОК: ${a.title}\nОПИСАНИЕ: ${a.description||''}`).join('\n\n');
    const text = await callAI(
      `Переведи молдавские/румынские новости на русский язык. Отвечай ТОЛЬКО JSON массивом объектов {title, description} без пояснений.\n\n${texts}\n\nJSON массив ${toTranslate.length} объектов:`,
      2000
    );
    const translated = parseJSON(text);
    toTranslate.forEach((a,i) => {
      if (translated[i]) {
        const idx = articles.findIndex(x => x.id === a.id);
        if (idx !== -1) {
          articles[idx].titleRu = translated[i].title || a.title;
          articles[idx].descriptionRu = translated[i].description || a.description;
          articles[idx].translated = true;
        }
      }
    });
    cache.agentStats.translator.processed += toTranslate.length;
    cache.agentStats.translator.lastRun = new Date();
    cache.agentStats.translator.status = 'ok';
    console.log(`[АГЕНТ-ПЕРЕВОДЧИК] ✓ Переведено ${toTranslate.length} статей`);
  } catch(e) {
    cache.agentStats.translator.status = 'error';
    console.log(`[АГЕНТ-ПЕРЕВОДЧИК] ✗ ${e.message}`);
  }
  return articles;
}

// Агент 3: Краткое содержание
async function agentSummarizer(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return articles;
  const toSum = articles.filter(a => !a.summary && a.description && a.description.length > 80).slice(0, 10);
  if (!toSum.length) return articles;
  cache.agentStats.summarizer.status = 'running';
  console.log(`[АГЕНТ-РЕЗЮМЕ] Создаю ${toSum.length} резюме...`);
  try {
    const texts = toSum.map((a,i) => `${i+1}. ${a.title}: ${a.description}`).join('\n\n');
    const text = await callAI(
      `Для каждой новости напиши краткое резюме на русском (1 предложение, max 90 символов). Отвечай ТОЛЬКО JSON массивом строк.\n\n${texts}\n\nJSON массив ${toSum.length} строк:`
    );
    const summaries = parseJSON(text);
    toSum.forEach((a,i) => {
      if (summaries[i]) {
        const idx = articles.findIndex(x => x.id === a.id);
        if (idx !== -1) articles[idx].summary = summaries[i];
      }
    });
    cache.agentStats.summarizer.processed += toSum.length;
    cache.agentStats.summarizer.lastRun = new Date();
    cache.agentStats.summarizer.status = 'ok';
    console.log(`[АГЕНТ-РЕЗЮМЕ] ✓ Создано ${toSum.length} резюме`);
  } catch(e) {
    cache.agentStats.summarizer.status = 'error';
    console.log(`[АГЕНТ-РЕЗЮМЕ] ✗ ${e.message}`);
  }
  return articles;
}

// Агент 4: Тренды
async function agentTrends(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  cache.agentStats.trends.status = 'running';
  console.log('[АГЕНТ-ТРЕНДЫ] Анализирую тренды...');
  try {
    const titles = articles.slice(0,30).map(a => a.title).join('\n');
    const text = await callAI(
      `Проанализируй молдавские новости и выдели 5 главных трендов дня. Для каждого: название (3-4 слова на русском), количество связанных новостей, подходящий эмодзи. Отвечай ТОЛЬКО JSON массивом объектов {topic, count, emoji}.\n\nНовости:\n${titles}\n\nJSON массив 5 объектов:`,
      400
    );
    cache.trends = parseJSON(text);
    cache.agentStats.trends.processed++;
    cache.agentStats.trends.lastRun = new Date();
    cache.agentStats.trends.status = 'ok';
    console.log(`[АГЕНТ-ТРЕНДЫ] ✓ Найдено ${cache.trends.length} трендов`);
  } catch(e) {
    cache.agentStats.trends.status = 'error';
    console.log(`[АГЕНТ-ТРЕНДЫ] ✗ ${e.message}`);
  }
}

// Агент 5: Дайджест
async function agentDigest(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  cache.agentStats.digest.status = 'running';
  console.log('[АГЕНТ-ДАЙДЖЕСТ] Создаю дайджест...');
  try {
    const top = articles.slice(0,20).map(a => `- ${a.title} (${a.source})`).join('\n');
    const text = await callAI(
      `Ты редактор ORA.MD. Создай утренний дайджест на русском. Формат: заголовок, вступление (2 предложения), топ-5 новостей с кратким пояснением. Стиль — профессиональный и живой. Отвечай ТОЛЬКО JSON объектом {title, intro, items:[{headline,summary}]}.\n\nНовости:\n${top}\n\nJSON:`,
      800
    );
    cache.digest = { ...parseJSON(text), createdAt: new Date() };
    cache.agentStats.digest.processed++;
    cache.agentStats.digest.lastRun = new Date();
    cache.agentStats.digest.status = 'ok';
    console.log('[АГЕНТ-ДАЙДЖЕСТ] ✓ Дайджест создан');
  } catch(e) {
    cache.agentStats.digest.status = 'error';
    console.log(`[АГЕНТ-ДАЙДЖЕСТ] ✗ ${e.message}`);
  }
}

// ════════════════════════════════════════
// RSS ПАРСИНГ
// ════════════════════════════════════════

function mkParser() {
  return new RSSParser({
    timeout: 12000,
    headers: { 'User-Agent': rndUA(), 'Accept': 'application/rss+xml, application/xml, text/xml, */*', 'Referer': 'https://www.google.com/' },
    customFields: { item: [['media:content','mediaContent'],['media:thumbnail','mediaThumbnail']] }
  });
}

async function parseSource(src) {
  const t0 = Date.now();
  let feed = null, method = '';
  try { feed = await mkParser().parseURL(src.url); method = 'direct'; } catch(e) {}
  for (let i=0; !feed && i<PROXIES.length; i++) {
    try { const r = await axios.get(PROXIES[i](src.url),{timeout:10000,headers:{'User-Agent':rndUA()}}); feed = await mkParser().parseString(r.data); method=`proxy-${i+1}`; } catch(e) {}
  }
  if (!feed) {
    try { const q=encodeURIComponent(src.name.replace('.md','')+' Moldova'); feed=await mkParser().parseURL(`https://news.google.com/rss/search?q=${q}&hl=ru&gl=MD&ceid=MD:ru`); method='google-news'; } catch(e) {}
  }
  const elapsed = Date.now()-t0;
  if (!feed?.items?.length) { cache.sourceStatus[src.id]={status:'error',elapsed:`${elapsed}ms`,lastUpdate:new Date()}; return []; }
  const articles = feed.items.slice(0,25).map(item=>({
    id: Buffer.from(item.link||item.title||Math.random().toString()).toString('base64').slice(0,16),
    source: src.name, sourceId: src.id,
    category: detectCat(item.title||'', item.categories, src.cat),
    title: clean(item.title),
    description: clean(item.contentSnippet||item.summary||item.content||'').slice(0,300),
    link: item.link||'', image: getImg(item),
    pubDate: item.pubDate?new Date(item.pubDate):new Date(),
    author: item.creator||item.author||src.name, lang: src.lang,
  })).filter(a=>a.title&&a.title.length>5);
  cache.sourceStatus[src.id]={status:'ok',count:articles.length,method,elapsed:`${elapsed}ms`,lastUpdate:new Date()};
  console.log(`[${src.name}] ✓ ${articles.length} | ${method} | ${elapsed}ms`);
  return articles;
}

async function parseAll() {
  console.log('\n═══ ЗАПУСК ВСЕХ АГЕНТОВ ═══');
  const t0 = Date.now();
  const results = await Promise.allSettled(SOURCES.map(s=>parseSource(s)));
  let all=[], ok=0, failed=0;
  results.forEach(r=>{ if(r.status==='fulfilled'&&r.value.length>0){all=all.concat(r.value);ok++;}else failed++; });
  all.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  const seen=new Set();
  all=all.filter(a=>{const k=a.title.toLowerCase().slice(0,60);if(seen.has(k))return false;seen.add(k);return true;});
  cache.articles=all; cache.lastUpdate=new Date(); cache.stats={total:all.length,ok,failed};
  console.log(`═══ RSS: ${all.length} статей | ${ok}✓ ${failed}✗ | ${((Date.now()-t0)/1000).toFixed(1)}с ═══`);

  // AI агенты
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('\n─── AI агенты ───');
    cache.articles = await agentTranslator(cache.articles);
    cache.articles = await agentEditor(cache.articles);
    cache.articles = await agentSummarizer(cache.articles);
    await agentTrends(cache.articles);
    if (!cache.digest) await agentDigest(cache.articles);
    console.log('─── AI агенты завершены ───\n');
  }
}

// ── УТИЛИТЫ ──
function clean(t){if(!t)return'';return t.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();}
function getImg(item){if(item.enclosure?.url)return item.enclosure.url;if(item.mediaContent?.['$']?.url)return item.mediaContent['$'].url;if(item.mediaThumbnail?.['$']?.url)return item.mediaThumbnail['$'].url;const html=item.content||item['content:encoded']||'';const m=html.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/i);return m?m[1]:null;}
const CATS={'Политика':['парламент','правительств','президент','санду','выбор','партия','депутат','министр','закон','премьер'],'Экономика':['лей','доллар','евро','курс','банк','бюджет','зарплат','налог','инфляци','ввп'],'Спорт':['футбол','теннис','чемпион','медал','турнир','матч','спортсмен','кубок'],'Культура':['музей','театр','кино','фестивал','концерт','eurovision','евровидени'],'Здоровье':['больниц','медицин','вирус','вакцин','здоровь','врач','лечени'],'Технологии':['технолог','интернет','цифров','искусственный интеллект','стартап'],'Мир':['украин','росси','европ','сша','нато','ес','война','международн','оон'],'Происшествия':['авария','пожар','дтп','полици','арест','задержан','преступ']};
function detectCat(title,cats,def){const t=title.toLowerCase();for(const[cat,words]of Object.entries(CATS)){if(words.some(w=>t.includes(w)))return cat;}return cats?.[0]||def||'Общество';}

// ── API ──
function withAI(a){return{...a,displayTitle:a.aiTitle||a.titleRu||a.title,displayDescription:a.summary||a.descriptionRu||a.description};}

app.get('/api/news',(req,res)=>{
  const{category,source,lang,limit=50,page=1}=req.query;
  let arts=[...cache.articles];
  if(category)arts=arts.filter(a=>a.category.toLowerCase()===category.toLowerCase());
  if(source)arts=arts.filter(a=>a.sourceId===source);
  if(lang)arts=arts.filter(a=>a.lang===lang);
  arts=arts.map(withAI);
  const lim=+limit,pg=+page,start=(pg-1)*lim;
  res.json({success:true,total:arts.length,page:pg,limit:lim,articles:arts.slice(start,start+lim),lastUpdate:cache.lastUpdate});
});
app.get('/api/news/top',(req,res)=>res.json({success:true,articles:cache.articles.slice(0,10).map(withAI),lastUpdate:cache.lastUpdate}));
app.get('/api/news/search',(req,res)=>{const q=(req.query.q||'').toLowerCase();if(!q)return res.json({success:false,error:'Нужен ?q='});const arts=cache.articles.filter(a=>a.title.toLowerCase().includes(q)||(a.aiTitle||'').toLowerCase().includes(q)||a.description.toLowerCase().includes(q)).slice(0,20);res.json({success:true,query:req.query.q,total:arts.length,articles:arts.map(withAI)});});
app.get('/api/news/category/:cat',(req,res)=>{const arts=cache.articles.filter(a=>a.category.toLowerCase()===req.params.cat.toLowerCase()).slice(0,30);res.json({success:true,category:req.params.cat,total:arts.length,articles:arts.map(withAI)});});
app.get('/api/news/:id',(req,res)=>{const a=cache.articles.find(a=>a.id===req.params.id);if(!a)return res.status(404).json({success:false,error:'Не найдено'});res.json({success:true,article:withAI(a)});});
app.get('/api/categories',(req,res)=>{const cnt={};cache.articles.forEach(a=>{cnt[a.category]=(cnt[a.category]||0)+1;});res.json({success:true,categories:Object.entries(cnt).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count)});});
app.get('/api/trends',(req,res)=>res.json({success:true,trends:cache.trends,lastUpdate:cache.agentStats.trends.lastRun}));
app.get('/api/digest',(req,res)=>{if(!cache.digest)return res.json({success:false,error:'Дайджест ещё создаётся'});res.json({success:true,digest:cache.digest});});
app.get('/api/agents',(req,res)=>res.json({success:true,aiEnabled:!!process.env.ANTHROPIC_API_KEY,agents:{editor:{name:'Редактор заголовков',...cache.agentStats.editor},translator:{name:'Переводчик RO→RU',...cache.agentStats.translator},summarizer:{name:'Краткое содержание',...cache.agentStats.summarizer},trends:{name:'Анализ трендов',...cache.agentStats.trends},digest:{name:'Утренний дайджест',...cache.agentStats.digest}}}));
app.get('/api/sources',(req,res)=>res.json({success:true,sources:SOURCES.map(s=>({...s,status:cache.sourceStatus[s.id]||{status:'pending'}}))}));
app.get('/api/status',(req,res)=>res.json({success:true,server:{uptime:Math.floor(process.uptime())+'s',memory:Math.round(process.memoryUsage().heapUsed/1024/1024)+'MB',node:process.version},cache:{...cache.stats,lastUpdate:cache.lastUpdate},ai:{enabled:!!process.env.ANTHROPIC_API_KEY,...cache.agentStats},sources:SOURCES.map(s=>({id:s.id,name:s.name,...cache.sourceStatus[s.id]}))}));
app.post('/api/parse',(req,res)=>{res.json({success:true,message:'Запущено!'});parseAll();});
app.post('/api/agents/editor',async(req,res)=>{cache.articles=await agentEditor(cache.articles);res.json({success:true,...cache.agentStats.editor});});
app.post('/api/agents/translator',async(req,res)=>{cache.articles=await agentTranslator(cache.articles);res.json({success:true,...cache.agentStats.translator});});
app.post('/api/agents/summarizer',async(req,res)=>{cache.articles=await agentSummarizer(cache.articles);res.json({success:true,...cache.agentStats.summarizer});});
app.post('/api/agents/trends',async(req,res)=>{await agentTrends(cache.articles);res.json({success:true,trends:cache.trends});});
app.post('/api/agents/digest',async(req,res)=>{await agentDigest(cache.articles);res.json({success:true,digest:cache.digest});});

app.get('/api/currency',async(req,res)=>{
  try{const r=await axios.get(PROXIES[0]('https://www.bnm.md/ro/content/rss'),{timeout:8000});const xml=r.data;const items=[];const re=/<item>([\s\S]*?)<\/item>/g;let m;while((m=re.exec(xml))!==null){const t=m[1].match(/<title>(.*?)<\/title>/);const d=m[1].match(/<description>([\s\S]*?)<\/description>/);if(t&&d)items.push({title:clean(t[1]),description:clean(d[1])});}res.json({success:true,items,source:'bnm.md'});}
  catch(e){res.json({success:true,source:'fallback',items:[{currency:'USD',rate:17.84,change:-0.03,name:'Доллар США'},{currency:'EUR',rate:20.15,change:-0.03,name:'Евро'},{currency:'RON',rate:4.05,change:+0.01,name:'Румынский лей'},{currency:'RUB',rate:0.21,change:0,name:'Российский рубль'}]});}
});

// ── CRON ──
cron.schedule('*/15 * * * *',()=>parseAll());
cron.schedule('0 * * * *',()=>{cache.articles=[];parseAll();});
cron.schedule('0 9 * * *',()=>agentDigest(cache.articles));

// ── ЗАПУСК ──
const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  console.log(`
╔══════════════════════════════════════════╗
║    ORA.MD — RSS + AI Сервер v3.0        ║
║    http://localhost:${PORT}                ║
╠══════════════════════════════════════════╣
║  🤖 Редактор заголовков                  ║
║  🌍 Переводчик RO→RU                     ║
║  📝 Краткое содержание                   ║
║  📈 Анализ трендов                       ║
║  🗞️  Утренний дайджест (9:00)            ║
╠══════════════════════════════════════════╣
║  AI: ${process.env.ANTHROPIC_API_KEY?'✅ АКТИВЕН':'⚠️  Нужен ANTHROPIC_API_KEY'}
╚══════════════════════════════════════════╝
  `);
  await parseAll();
});
