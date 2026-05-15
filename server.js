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

// ── USER-AGENT'Ы ──
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Googlebot/2.1 (+http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
];
const rndUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ── ПРОКСИ ЦЕПОЧКА ──
const PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

// ── RSS ИСТОЧНИКИ ──
const SOURCES = [
  { id: 'noi',       name: 'Noi.md',        url: 'https://noi.md/rss/ru',             cat: 'Общество',  lang: 'ru' },
  { id: 'point',     name: 'Point.md',      url: 'https://point.md/rss.php',          cat: 'Политика',  lang: 'ru' },
  { id: 'newsmaker', name: 'NewsMaker.md',  url: 'https://newsmaker.md/ru/rss',       cat: 'Общество',  lang: 'ru' },
  { id: 'moldova1',  name: 'Moldova1.md',   url: 'https://moldova1.md/rss',           cat: 'Общество',  lang: 'ro' },
  { id: 'nokta',     name: 'Nokta.md',      url: 'https://nokta.md/feed',             cat: 'Общество',  lang: 'ru' },
  { id: 'deschide',  name: 'Deschide.md',   url: 'https://deschide.md/rss',           cat: 'Политика',  lang: 'ro' },
  { id: 'eved',      name: 'eVedomosti.md', url: 'http://www.evedomosti.md/rss.php',  cat: 'Политика',  lang: 'ru' },
  { id: 'nbm',       name: 'НБМ',           url: 'https://www.bnm.md/ro/content/rss', cat: 'Экономика', lang: 'ro' },
];

// ── КЭШ ──
let cache = {
  articles: [],
  lastUpdate: null,
  sourceStatus: {},
  stats: { total: 0, ok: 0, failed: 0 }
};

// ── СОЗДАТЬ ПАРСЕР ──
function mkParser(ua) {
  return new RSSParser({
    timeout: 12000,
    headers: {
      'User-Agent': ua || rndUA(),
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Referer': 'https://www.google.com/',
    },
    customFields: { item: [['media:content','mediaContent'],['media:thumbnail','mediaThumbnail']] }
  });
}

// ── ПАРСИНГ ОДНОГО ИСТОЧНИКА ──
async function parseSource(src) {
  const t0 = Date.now();
  console.log(`[${src.name}] Парсинг...`);
  let feed = null, method = '';

  // Метод 1: Прямой
  try { feed = await mkParser().parseURL(src.url); method = 'direct'; }
  catch(e) { console.log(`  ✗ direct: ${e.message.slice(0,60)}`); }

  // Методы 2-4: Прокси цепочка
  for (let i = 0; !feed && i < PROXIES.length; i++) {
    try {
      const proxyUrl = PROXIES[i](src.url);
      const resp = await axios.get(proxyUrl, { timeout: 10000, headers: { 'User-Agent': rndUA() } });
      feed = await mkParser().parseString(resp.data);
      method = `proxy-${i+1}`;
    } catch(e) { console.log(`  ✗ proxy-${i+1}: ${e.message.slice(0,60)}`); }
  }

  // Метод 5: Google News RSS
  if (!feed) {
    try {
      const q = encodeURIComponent(src.name.replace('.md','') + ' Moldova');
      const gnUrl = `https://news.google.com/rss/search?q=${q}&hl=ru&gl=MD&ceid=MD:ru`;
      feed = await mkParser('Googlebot/2.1').parseURL(gnUrl);
      method = 'google-news';
    } catch(e) { console.log(`  ✗ google-news: ${e.message.slice(0,60)}`); }
  }

  const elapsed = Date.now() - t0;

  if (!feed || !feed.items?.length) {
    cache.sourceStatus[src.id] = { status: 'error', error: 'Все методы исчерпаны', elapsed: `${elapsed}ms`, lastUpdate: new Date() };
    console.log(`[${src.name}] ✗ ОШИБКА (${elapsed}ms)`);
    return [];
  }

  const articles = feed.items.slice(0, 25).map(item => ({
    id: Buffer.from(item.link || item.title || Math.random().toString()).toString('base64').slice(0, 16),
    source: src.name,
    sourceId: src.id,
    category: detectCat(item.title || '', item.categories, src.cat),
    title: clean(item.title),
    description: clean(item.contentSnippet || item.summary || item.content || '').slice(0, 300),
    link: item.link || '',
    image: getImg(item),
    pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
    author: item.creator || item.author || src.name,
    lang: src.lang,
  })).filter(a => a.title && a.title.length > 5);

  cache.sourceStatus[src.id] = { status: 'ok', count: articles.length, method, elapsed: `${elapsed}ms`, lastUpdate: new Date() };
  console.log(`[${src.name}] ✓ ${articles.length} статей | ${method} | ${elapsed}ms`);
  return articles;
}

// ── ПАРСИНГ ВСЕХ ИСТОЧНИКОВ ──
async function parseAll() {
  console.log('\n═══ RSS-АГЕНТ: запуск ═══');
  const t0 = Date.now();

  const results = await Promise.allSettled(SOURCES.map(s => parseSource(s)));

  let all = [], ok = 0, failed = 0;
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.length > 0) { all = all.concat(r.value); ok++; }
    else failed++;
  });

  // Сортировка новые первыми
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Дедупликация
  const seen = new Set();
  all = all.filter(a => {
    const k = a.title.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  cache.articles = all;
  cache.lastUpdate = new Date();
  cache.stats = { total: all.length, ok, failed };

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`═══ ГОТОВО: ${all.length} статей | ${ok}✓ ${failed}✗ | ${elapsed}с ═══\n`);
  return cache;
}

// ── УТИЛИТЫ ──
function clean(t) {
  if (!t) return '';
  return t.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
}

function getImg(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.mediaContent?.['$']?.url) return item.mediaContent['$'].url;
  if (item.mediaThumbnail?.['$']?.url) return item.mediaThumbnail['$'].url;
  const html = item.content || item['content:encoded'] || '';
  const m = html.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/i);
  return m ? m[1] : null;
}

const CATS = {
  'Политика':    ['парламент','правительств','президент','санду','выбор','партия','депутат','министр','закон','премьер','мэр'],
  'Экономика':   ['лей','доллар','евро','курс','банк','бюджет','зарплат','налог','инфляци','ввп','инвестиц','цен'],
  'Спорт':       ['футбол','теннис','чемпион','медал','турнир','матч','спортсмен','кубок','олимпи'],
  'Культура':    ['музей','театр','кино','фестивал','концерт','eurovision','евровидени','искусств'],
  'Здоровье':    ['больниц','медицин','вирус','вакцин','здоровь','врач','лечени','болезн'],
  'Технологии':  ['технолог','интернет','цифров','искусственный интеллект','стартап','it','ии'],
  'Мир':         ['украин','росси','европ','сша','нато','ес','война','международн','оон'],
  'Происшествия':['авария','пожар','дтп','полици','арест','задержан','обыск','преступ'],
};

function detectCat(title, cats, def) {
  const t = title.toLowerCase();
  for (const [cat, words] of Object.entries(CATS)) {
    if (words.some(w => t.includes(w))) return cat;
  }
  return cats?.[0] || def || 'Общество';
}

// ── API МАРШРУТЫ ──

app.get('/api/news', (req, res) => {
  const { category, source, lang, limit = 50, page = 1 } = req.query;
  let arts = [...cache.articles];
  if (category) arts = arts.filter(a => a.category.toLowerCase() === category.toLowerCase());
  if (source)   arts = arts.filter(a => a.sourceId === source);
  if (lang)     arts = arts.filter(a => a.lang === lang);
  const lim = +limit, pg = +page, start = (pg - 1) * lim;
  res.json({ success: true, total: arts.length, page: pg, limit: lim, articles: arts.slice(start, start + lim), lastUpdate: cache.lastUpdate });
});

app.get('/api/news/top',           (req, res) => res.json({ success: true, articles: cache.articles.slice(0, 10), lastUpdate: cache.lastUpdate }));
app.get('/api/news/category/:cat', (req, res) => {
  const arts = cache.articles.filter(a => a.category.toLowerCase() === req.params.cat.toLowerCase()).slice(0, 30);
  res.json({ success: true, category: req.params.cat, total: arts.length, articles: arts });
});
app.get('/api/news/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ success: false, error: 'Нужен параметр ?q=' });
  const arts = cache.articles.filter(a => a.title.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)).slice(0, 20);
  res.json({ success: true, query: req.query.q, total: arts.length, articles: arts });
});
app.get('/api/news/:id', (req, res) => {
  const a = cache.articles.find(a => a.id === req.params.id);
  if (!a) return res.status(404).json({ success: false, error: 'Не найдено' });
  res.json({ success: true, article: a });
});
app.get('/api/categories', (req, res) => {
  const cnt = {};
  cache.articles.forEach(a => { cnt[a.category] = (cnt[a.category] || 0) + 1; });
  res.json({ success: true, categories: Object.entries(cnt).map(([name,count]) => ({name,count})).sort((a,b) => b.count-a.count) });
});
app.get('/api/sources', (req, res) => {
  res.json({ success: true, sources: SOURCES.map(s => ({ ...s, status: cache.sourceStatus[s.id] || { status: 'pending' } })) });
});
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    server: { uptime: Math.floor(process.uptime()) + 's', memory: Math.round(process.memoryUsage().heapUsed/1024/1024)+'MB', node: process.version },
    cache: { ...cache.stats, lastUpdate: cache.lastUpdate },
    sources: SOURCES.map(s => ({ id: s.id, name: s.name, ...cache.sourceStatus[s.id] }))
  });
});
app.post('/api/parse', (req, res) => {
  res.json({ success: true, message: 'Парсинг запущен' });
  parseAll();
});

// Курс валют НБМ
app.get('/api/currency', async (req, res) => {
  try {
    const url = 'https://www.bnm.md/ro/content/rss';
    const proxyUrl = PROXIES[0](url);
    const resp = await axios.get(proxyUrl, { timeout: 8000 });
    const xml = resp.data;
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const t = m[1].match(/<title>(.*?)<\/title>/);
      const d = m[1].match(/<description>([\s\S]*?)<\/description>/);
      if (t && d) items.push({ title: clean(t[1]), description: clean(d[1]) });
    }
    res.json({ success: true, items, source: 'bnm.md' });
  } catch(e) {
    res.json({
      success: true, source: 'fallback',
      items: [
        { currency:'USD', rate:17.84, change:-0.03, name:'Доллар США' },
        { currency:'EUR', rate:20.15, change:-0.03, name:'Евро' },
        { currency:'RON', rate:4.05,  change:+0.01, name:'Румынский лей' },
        { currency:'RUB', rate:0.21,  change:0,     name:'Российский рубль' },
      ]
    });
  }
});

// ── CRON ──
cron.schedule('*/15 * * * *', () => { console.log('[CRON] Авто-обновление RSS...'); parseAll(); });
cron.schedule('0 * * * *',    () => { console.log('[CRON] Полный сброс кэша...'); cache.articles = []; parseAll(); });

// ── ЗАПУСК ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║      ORA.MD — RSS Сервер v2.0           ║
║      http://localhost:${PORT}              ║
╠══════════════════════════════════════════╣
║  GET  /api/news            все новости   ║
║  GET  /api/news/top        топ-10        ║
║  GET  /api/news/search?q=  поиск         ║
║  GET  /api/news/category/  по рубрике    ║
║  GET  /api/categories      рубрики       ║
║  GET  /api/sources         источники     ║
║  GET  /api/currency        курс НБМ      ║
║  GET  /api/status          статус        ║
║  POST /api/parse           запуск        ║
╚══════════════════════════════════════════╝
  `);
  await parseAll();
});
