import { kv } from '@vercel/kv';

// All helper functions are still needed
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
async function tmdb(path, params = {}) { const url = new URL(TMDB_BASE + path); url.searchParams.set('api_key', TMDB_API_KEY); url.searchParams.set('language', 'en-US'); for (const key in params) { url.searchParams.set(key, params[key]); } const res = await fetch(url); if (!res.ok) throw new Error(`TMDB API error: ${res.statusText}`); return res.json(); }
const EN_STOP = new Set('a,an,and,are,as,at,be,by,for,from,has,he,in,is,it,its,of,on,that,the,they,this,to,was,were,with,will,his,her,have,not,or,if,into,over,after,before,also,about,them,than,then,when,while,who,whom,which,what,why,how,their,there,been,do,does,did,doing,up,down,out,off,again,further,more,most,other,own,same,so,too,very,can,just,should,now'.split(','));
function tokenize(txt) { if (!txt) return []; const clean = txt.toLowerCase().replace(/[^\p{L}\s]/gu, ' '); return clean.split(/\s+/).filter(t => t.length > 2 && !EN_STOP.has(t)); }
function tf(tokens) { const f = new Map(); tokens.forEach(t => f.set(t, (f.get(t) || 0) + 1)); return f; }
function buildTfidf(corpusTokens) { const df = new Map(); corpusTokens.forEach(tokMap => { const seen = new Set(tokMap.keys()); seen.forEach(t => df.set(t, (df.get(t) || 0) + 1)); }); const N = corpusTokens.length; const idf = new Map(); df.forEach((v, k) => idf.set(k, Math.log((N + 1) / (v + 1)) + 1)); return { idf }; }
function vecFrom(tfMap, idf) { const v = new Map(); let norm = 0; tfMap.forEach((count, term) => { const w = (1 + Math.log(count)) * (idf.get(term) || 0); v.set(term, w); norm += w * w; }); return { v, norm: Math.sqrt(norm) }; }
function cosine(v1, n1, v2, n2) { if (!n1 || !n2) return 0; let dot = 0; v1.forEach((w, t) => { const w2 = v2.get(t); if (w2) dot += w * w2; }); return dot / (n1 * n2); }
async function fetchDetailsWithKeywords(item, type) { type = type || item.media_type || 'movie'; const path = type === 'movie' ? `/movie/${item.id}` : `/tv/${item.id}`; const [details, keywordsResponse] = await Promise.all([tmdb(path), tmdb(`${path}/keywords`)]); let keywords = []; if (keywordsResponse.keywords) keywords = keywordsResponse.keywords.map(k => k.name); else if (keywordsResponse.results) keywords = keywordsResponse.results.map(k => k.name); return { ...details, keywords, media_type: type }; }

// ===============================================
// THE FINAL, ULTIMATE HANDLER
// ===============================================
export default async function handler(request, response) {
  const { id, type } = request.query;
  if (!id || !type) {
    return response.status(400).json({ message: 'ID and type are required' });
  }
  const dbKey = `${type}:${id}`;

  try {
    // 1. Check the database first (fast path)
    const cachedData = await kv.get(dbKey);
    if (cachedData) {
      return response.status(200).json(cachedData);
    }

    // 2. If not in DB, perform the ULTIMATE on-demand calculation
    console.log(`Cache miss for ${dbKey}. Performing final optimized calculation...`);
    
    // THE BIG OPTIMIZATION: Use TMDB's "similar" list as a high-quality candidate pool.
    // This is much faster and more relevant.
    const similarResponse = await tmdb(`/${type}/${id}/similar`);
    const candidates = (similarResponse.results || []).filter(c => c.overview && c.poster_path);

    if (candidates.length < 5) {
        // If TMDB itself has few similar items, just return them as a fallback.
        console.log(`Not enough candidates for ${dbKey}. Returning TMDB's list directly.`);
        await kv.set(dbKey, candidates, { ex: 60 * 60 * 24 * 7 }); // Cache for 7 days
        return response.status(200).json(candidates);
    }

    const details = await fetchDetailsWithKeywords({ id, media_type: type }, type);
    
    const targetGenres = details.genres ? details.genres.map(g => g.name) : [];
    const targetRichText = [details.overview, ...Array(5).fill(targetGenres.join(' ')), ...Array(10).fill(details.keywords.join(' '))].join(' ');
    const targetTF = tf(tokenize(targetRichText));
    
    // We don't need the genreMap anymore as candidates are already relevant
    const corpTFs = candidates.map(c => {
        const candidateRichText = c.overview; // Simpler text doc for candidates
        return tf(tokenize(candidateRichText));
    });

    const allTFs = [targetTF, ...corpTFs];
    const { idf } = buildTfidf(allTFs);
    const tgtVec = vecFrom(targetTF, idf);
    
    let scored = candidates.map((c, i) => {
        const v = vecFrom(allTFs[i+1], idf);
        const score = cosine(tgtVec.v, tgtVec.norm, v.v, v.norm);
        c.media_type = c.media_type || (c.first_air_date ? 'tv' : 'movie');
        return { item: c, score };
    }).filter(x => x.score > 0.01); // Lower threshold is fine with better candidates
    
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, 50);

    // Save the new result to the database
    if (topResults.length > 0) {
        await kv.set(dbKey, topResults, { ex: 60 * 60 * 24 * 30 }); // Expires in 30 days
    }
    
    return response.status(200).json(topResults);

  } catch (error) {
    // FALLBACK PLAN: If our smart calculation fails for any reason
    console.error(`Smart calculation failed for ${dbKey}: ${error.message}. Using fallback.`);
    try {
        const fallbackResponse = await tmdb(`/${type}/${id}/recommendations`);
        const fallbackResults = fallbackResponse.results || [];
        return response.status(200).json(fallbackResults);
    } catch (fallbackError) {
        return response.status(500).json({ message: 'Both calculation and fallback failed.' });
    }
  }
}