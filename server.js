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
  { id:'noi',       name:'Noi.md',        url:'https://noi.md/rss/ru',              cat:'Общество',  lang:'ru' },
  { id:'point',     name:'Point.md',      url:'https://point.md/rss.php',           cat:'Политика',  lang:'ru' },
  { id:'newsmaker', name:'NewsMaker.md',  url:'https://newsmaker.md/ru/rss',        cat:'Общество',  lang:'ru' },
  { id:'moldova1',  name:'Moldova1.md',   url:'https://moldova1.md/rss',            cat:'Общество',  lang:'ro' },
  { id:'nokta',     name:'Nokta.md',      url:'https://nokta.md/feed',              cat:'Общество',  lang:'ru' },
  { id:'deschide',  name:'Deschide.md',   url:'https://deschide.md/rss',            cat:'Politică',  lang:'ro' },
  { id:'eved',      name:'eVedomosti.md', url:'http://www.evedomosti.md/rss.php',   cat:'Политика',  lang:'ru' },
  { id:'nbm',       name:'НБМ',           url:'https://www.bnm.md/ro/content/rss',  cat:'Economie',  lang:'ro' },
  { id:'unimedia',  name:'Unimedia.md',   url:'https://unimedia.info/feed/',         cat:'Politică',  lang:'ro' },
  { id:'stiri',     name:'Stiri.md',      url:'https://stiri.md/feed',               cat:'Societate', lang:'ro' },
  { id:'ziua',      name:'Ziua.md',       url:'https://ziua.md/feed/',               cat:'Societate', lang:'ro' },
  { id:'moldova',   name:'Moldova.org',   url:'https://www.moldova.org/feed/',       cat:'Societate', lang:'ro' },
  { id:'locals',    name:'Locals.md',     url:'https://locals.md/feed',              cat:'Societate', lang:'ro' },
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

async function agentEditor(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return articles;
  const toProcess = articles.filter(a => !a.aiTitle).slice(0, 15);
  if (!toProcess.length) return articles;
  cache.agentStats.editor.status = 'running';
  try {
    const list = toProcess.map((a,i) => `${i+1}. [${a.category}] ${a.title}`).join('\n');
    const text = await callAI(`Ești editorul portalului de știri ORA.MD din Moldova. Fă titlurile mai interesante și atractive pentru cititorii din Moldova. Păstrează esența dar adaugă intrigă. Răspunde DOAR cu un array JSON de șiruri fără explicații.\n\nTitluri:\n${list}\n\nArray JSON cu ${toProcess.length} șiruri:`);
    const improved = parseJSON(text);
    toProcess.forEach((a,i) => {
      if (improved[i]) { const idx = articles.findIndex(x => x.id === a.id); if (idx !== -1) articles[idx].aiTitle = improved[i]; }
    });
    cache.agentStats.editor.processed += toProcess.length;
    cache.agentStats.editor.lastRun = new Date();
    cache.agentStats.editor.status = 'ok';
  } catch(e) { cache.agentStats.editor.status = 'error'; }
  return articles;
}

async function agentTranslator(articles) { return articles; }

async function agentSummarizer(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return articles;
  const toSum = articles.filter(a => !a.summary && a.description && a.description.length > 80).slice(0, 10);
  if (!toSum.length) return articles;
  cache.agentStats.summarizer.status = 'running';
  try {
    const texts = toSum.map((a,i) => `${i+1}. ${a.title}: ${a.description}`).join('\n\n');
    const text = await callAI(`Pentru fiecare știre scrie un rezumat scurt (1 propoziție, max 90 caractere). Răspunde DOAR cu un array JSON de șiruri.\n\n${texts}\n\nArray JSON cu ${toSum.length} șiruri:`);
    const summaries = parseJSON(text);
    toSum.forEach((a,i) => {
      if (summaries[i]) { const idx = articles.findIndex(x => x.id === a.id); if (idx !== -1) articles[idx].summary = summaries[i]; }
    });
    cache.agentStats.summarizer.processed += toSum.length;
    cache.agentStats.summarizer.lastRun = new Date();
    cache.agentStats.summarizer.status = 'ok';
  } catch(e) { cache.agentStats.summarizer.status = 'error'; }
  return articles;
}

async function agentTrends(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  cache.agentStats.trends.status = 'running';
  try {
    const titles = articles.slice(0,30).map(a => a.title).join('\n');
    const text = await callAI(`Analizează știrile din Moldova și identifică 5 tendințe principale ale zilei. Pentru fiecare: nume (3-4 cuvinte), numărul de știri asociate, emoji potrivit. Răspunde DOAR cu un array JSON de obiecte {topic, count, emoji}.\n\nȘtiri:\n${titles}\n\nArray JSON cu 5 obiecte:`, 400);
    cache.trends = parseJSON(text);
    cache.agentStats.trends.processed++;
    cache.agentStats.trends.lastRun = new Date();
    cache.agentStats.trends.status = 'ok';
  } catch(e) { cache.agentStats.trends.status = 'error'; }
}

async function agentDigest(articles) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  cache.agentStats.digest.status = 'running';
  try {
    const top = articles.slice(0,20).map(a => `- ${a.title} (${a.source})`).join('\n');
    const text = await callAI(`Ești editorul ORA.MD. Creează un digest de dimineață în română. Format: titlu, introducere (2 propoziții), top-5 știri cu explicație scurtă. Stil profesional și viu. Răspunde DOAR cu obiect JSON {title, intro, items:[{headline,summary}]}.\n\nȘtiri:\n${top}\n\nJSON:`, 800);
    cache.digest = { ...parseJSON(text), createdAt: new Date() };
    cache.agentStats.digest.processed++;
    cache.agentStats.digest.lastRun = new Date();
    cache.agentStats.digest.status = 'ok';
  } catch(e) { cache.agentStats.digest.status = 'error'; }
}

function mkParser() {
  return new RSSParser({
    timeout: 10000,
    headers: { 'User-Agent': rndUA(), 'Accept': 'application/rss+xml, application/xml, text/xml, */*', 'Referer': 'https://www.google.com/' },
    customFields: { item: [['media:content','mediaContent'],['media:thumbnail','mediaThumbnail']] }
  });
}

async function parseSource(src) {
  const t0 = Date.now();
  let feed = null, method = '';
  try { feed = await mkParser().parseURL(src.url); method = 'direct'; } catch(e) {}
  for (let i=0; !feed && i<PROXIES.length; i++) {
    try { const r = await axios.get(PROXIES[i](src.url),{timeout:8000,headers:{'User-Agent':rndUA()}}); feed = await mkParser().parseString(r.data); method=`proxy-${i+1}`; } catch(e) {}
  }
  if (!feed) {
    try { const q=encodeURIComponent(src.name.replace('.md','')+' Moldova'); feed=await mkParser().parseURL(`https://news.google.com/rss/search?q=${q}&hl=ro&gl=MD&ceid=MD:ro`); method='google-news'; } catch(e) {}
  }
  const elapsed = Date.now()-t0;
  if (!feed?.items?.length) { cache.sourceStatus[src.id]={status:'error',elapsed:`${elapsed}ms`,lastUpdate:new Date()}; return []; }
  const articles = feed.items.slice(0,20).map(item=>({
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
  return articles;
}

async function parseAll() {
  const t0 = Date.now();
  const results = await Promise.allSettled(SOURCES.map(s=>parseSource(s)));
  let all=[], ok=0, failed=0;
  results.forEach(r=>{ if(r.status==='fulfilled'&&r.value.length>0){all=all.concat(r.value);ok++;}else failed++; });
  all.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  const seen=new Set();
  all=all.filter(a=>{const k=a.title.toLowerCase().slice(0,60);if(seen.has(k))return false;seen.add(k);return true;});
  cache.articles=all; cache.lastUpdate=new Date(); cache.stats={total:all.length,ok,failed};
  if (process.env.ANTHROPIC_API_KEY) {
    const [edited, summarized] = await Promise.all([
      agentEditor([...cache.articles]),
      agentSummarizer([...cache.articles]),
      agentTrends(cache.articles),
    ]);
    cache.articles = cache.articles.map(a => {
      const e = edited.find(x=>x.id===a.id);
      const s = summarized.find(x=>x.id===a.id);
      return {...a, aiTitle: e?.aiTitle, summary: s?.summary};
    });
    if (!cache.digest) await agentDigest(cache.articles);
  }
}

function clean(t){if(!t)return'';return t.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();}
function getImg(item){if(item.enclosure?.url)return item.enclosure.url;if(item.mediaContent?.['$']?.url)return item.mediaContent['$'].url;if(item.mediaThumbnail?.['$']?.url)return item.mediaThumbnail['$'].url;const html=item.content||item['content:encoded']||'';const m=html.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/i);return m?m[1]:null;}

const CATS={
  'Политика':['парламент','правительств','президент','санду','выбор','партия','депутат','министр','закон','премьер'],
  'Politică':['parlament','guvern','președinte','sandu','alegeri','partid','deputat','ministru','lege','premier'],
  'Экономика':['лей','доллар','евро','курс','банк','бюджет','зарплат','налог','инфляци','ввп'],
  'Economie':['leu','dolar','euro','curs','bancă','buget','salariu','impozit','inflație','pib'],
  'Спорт':['футбол','теннис','чемпион','медал','турнир','матч','спортсмен','кубок'],
  'Sport':['fotbal','tenis','campion','medalie','turneu','meci','sportiv','cupă'],
  'Мир':['украин','росси','европ','сша','нато','ес','война','международн'],
  'Externe':['ucraina','rusia','europa','sua','nato','ue','război','internațional'],
};

function detectCat(title,cats,def){
  const t=title.toLowerCase();
  for(const[cat,words]of Object.entries(CATS)){if(words.some(w=>t.includes(w)))return cat;}
  return cats?.[0]||def||'Societate';
}

function withAI(a){return{...a,displayTitle:a.aiTitle||a.title,displayDescription:a.summary||a.description};}

function liteArticle(a){
  return {
    id:a.id,
    source:a.source,
    sourceId:a.sourceId,
    category:a.category,
    title:a.aiTitle||a.title,
    link:a.link,
    image:a.image,
    pubDate:a.pubDate,
    lang:a.lang,
  };
}


app.get('/api/news',(req,res)=>{
  const{category,source,lang,limit=50,page=1,lite}=req.query;
  let arts=[...cache.articles];
  if(category)arts=arts.filter(a=>a.category.toLowerCase()===category.toLowerCase());
  if(source)arts=arts.filter(a=>a.sourceId===source);
  if(lang)arts=arts.filter(a=>a.lang===lang);
  arts=lite==='1'?arts.map(liteArticle):arts.map(withAI);
  const lim=+limit,pg=+page,start=(pg-1)*lim;
  res.json({success:true,total:arts.length,page:pg,limit:lim,articles:arts.slice(start,start+lim),lastUpdate:cache.lastUpdate});
});
app.get('/api/news/top',(req,res)=>res.json({success:true,articles:cache.articles.slice(0,10).map(withAI),lastUpdate:cache.lastUpdate}));
app.get('/api/news/search',(req,res)=>{
  const q=(req.query.q||'').toLowerCase();
  if(!q)return res.json({success:false,error:'Нужен ?q='});
  const arts=cache.articles.filter(a=>a.title.toLowerCase().includes(q)||(a.aiTitle||'').toLowerCase().includes(q)||a.description.toLowerCase().includes(q)).slice(0,20);
  res.json({success:true,query:req.query.q,total:arts.length,articles:arts.map(withAI)});
});
app.get('/api/news/category/:cat',(req,res)=>{
  const arts=cache.articles.filter(a=>a.category.toLowerCase()===req.params.cat.toLowerCase()).slice(0,30);
  res.json({success:true,category:req.params.cat,total:arts.length,articles:arts.map(withAI)});
});
app.get('/api/news/:id',(req,res)=>{
  const a=cache.articles.find(a=>a.id===req.params.id);
  if(!a)return res.status(404).json({success:false,error:'Не найдено'});
  res.json({success:true,article:withAI(a)});
});
app.get('/api/categories',(req,res)=>{
  const cnt={};
  cache.articles.forEach(a=>{cnt[a.category]=(cnt[a.category]||0)+1;});
  res.json({success:true,categories:Object.entries(cnt).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count)});
});
app.get('/api/trends',(req,res)=>res.json({success:true,trends:cache.trends,lastUpdate:cache.agentStats.trends.lastRun}));
app.get('/api/digest',(req,res)=>{if(!cache.digest)return res.json({success:false,error:'Digestul se creează'});res.json({success:true,digest:cache.digest});});
app.get('/api/agents',(req,res)=>res.json({success:true,aiEnabled:!!process.env.ANTHROPIC_API_KEY,agents:{editor:{name:'Editor titluri',...cache.agentStats.editor},translator:{name:'Traducător RO→RU',...cache.agentStats.translator},summarizer:{name:'Rezumate',...cache.agentStats.summarizer},trends:{name:'Analiză tendințe',...cache.agentStats.trends},digest:{name:'Digest dimineață',...cache.agentStats.digest}}}));
app.get('/api/sources',(req,res)=>res.json({success:true,sources:SOURCES.map(s=>({...s,status:cache.sourceStatus[s.id]||{status:'pending'}}))}));
app.get('/api/status',(req,res)=>res.json({success:true,server:{uptime:Math.floor(process.uptime())+'s',memory:Math.round(process.memoryUsage().heapUsed/1024/1024)+'MB',node:process.version},cache:{...cache.stats,lastUpdate:cache.lastUpdate},ai:{enabled:!!process.env.ANTHROPIC_API_KEY,...cache.agentStats},sources:SOURCES.map(s=>({id:s.id,name:s.name,...cache.sourceStatus[s.id]}))}));

app.post('/api/parse',(req,res)=>{res.json({success:true,message:'Запущено!'});parseAll();});
app.post('/api/agents/editor',async(req,res)=>{cache.articles=await agentEditor(cache.articles);res.json({success:true,...cache.agentStats.editor});});
app.post('/api/agents/translator',async(req,res)=>{res.json({success:true,message:'Traducătorul este dezactivat'});});
app.post('/api/agents/summarizer',async(req,res)=>{cache.articles=await agentSummarizer(cache.articles);res.json({success:true,...cache.agentStats.summarizer});});
app.post('/api/agents/trends',async(req,res)=>{await agentTrends(cache.articles);res.json({success:true,trends:cache.trends});});
app.post('/api/agents/digest',async(req,res)=>{await agentDigest(cache.articles);res.json({success:true,digest:cache.digest});});

app.get('/api/currency',async(req,res)=>{
  try{
    const r=await axios.get(PROXIES[0]('https://www.bnm.md/ro/content/rss'),{timeout:8000});
    const xml=r.data;const items=[];
    const re=/<item>([\s\S]*?)<\/item>/g;let m;
    while((m=re.exec(xml))!==null){const t=m[1].match(/<title>(.*?)<\/title>/);const d=m[1].match(/<description>([\s\S]*?)<\/description>/);if(t&&d)items.push({title:clean(t[1]),description:clean(d[1])});}
    res.json({success:true,items,source:'bnm.md'});
  } catch(e){
    res.json({success:true,source:'fallback',items:[
      {currency:'USD',rate:17.84,change:-0.03,name:'Dolar SUA'},
      {currency:'EUR',rate:20.15,change:-0.03,name:'Euro'},
      {currency:'RON',rate:4.05,change:+0.01,name:'Leu românesc'},
      {currency:'RUB',rate:0.21,change:0,name:'Rubla rusă'},
    ]});
  }
});

// ── CRON ──
cron.schedule('*/15 * * * *', () => parseAll());
cron.schedule('0 9 * * *', () => agentDigest(cache.articles));
// Keepalive — не даём Railway усыплять сервер
cron.schedule('*/10 * * * *', () => {
  axios.get(`http://localhost:${process.env.PORT||3000}/api/status`).catch(()=>{});
});

// ── ЗАПУСК ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`ORA.MD Server v4.0 запущен на порту ${PORT}`);
  await parseAll();
});
