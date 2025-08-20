import { kv } from '@vercel/kv';

// We need to copy all the helper and calculation functions here
// so this endpoint can perform live calculations when needed.
// ===============================================
// HELPER FUNCTIONS (TMDB API & Text Processing)
// ===============================================

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";

async function tmdb(path, params = {}) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const key in params) {
    url.searchParams.set(key, params[key]);
  }
  const res = await fetch(url);
  return res.json();
}

const EN_STOP = new Set('a,an,and,are,as,at,be,by,for,from,has,he,in,is,it,its,of,on,that,the,they,this,to,was,were,with,will,his,her,have,not,or,if,into,over,after,before,also,about,them,than,then,when,while,who,whom,which,what,why,how,their,there,been,do,does,did,doing,up,down,out,off,again,further,more,most,other,own,same,so,too,very,can,just,should,now'.split(','));
function tokenize(txt) { if (!txt) return []; const clean = txt.toLowerCase().replace(/[^\p{L}\s]/gu, ' '); return clean.split(/\s+/).filter(t => t.length > 2 && !EN_STOP.has(t)); }
function tf(tokens) { const f = new Map(); tokens.forEach(t => f.set(t, (f.get(t) || 0) + 1)); return f; }
function buildTfidf(corpusTokens) { const df = new Map(); corpusTokens.forEach(tokMap => { const seen = new Set(tokMap.keys()); seen.forEach(t => df.set(t, (df.get(t) || 0) + 1)); }); const N = corpusTokens.length; const idf = new Map(); df.forEach((v, k) => idf.set(k, Math.log((N + 1) / (v + 1)) + 1)); return { idf }; }
function vecFrom(tfMap, idf) { const v = new Map(); let norm = 0; tfMap.forEach((count, term) => { const w = (1 + Math.log(count)) * (idf.get(term) || 0); v.set(term, w); norm += w * w; }); return { v, norm: Math.sqrt(norm) }; }
function cosine(v1, n1, v2, n2) { if (!n1 || !n2) return 0; let dot = 0; v1.forEach((w, t) => { const w2 = v2.get(t); if (w2) dot += w * w2; }); return dot / (n1 * n2); }
async function fetchDetailsWithKeywords(item, type) {
    type = type || item.media_type || 'movie';
    const path = type === 'movie' ? `/movie/${item.id}` : `/tv/${item.id}`;
    const [details, keywordsResponse] = await Promise.all([
      tmdb(path),
      tmdb(`${path}/keywords`)
    ]);
    let keywords = [];
    if (keywordsResponse.keywords) keywords = keywordsResponse.keywords.map(k => k.name);
    else if (keywordsResponse.results) keywords = keywordsResponse.results.map(k => k.name);
    return { ...details, keywords };
}

// ===============================================
// THE NEW "ON-DEMAND" HANDLER
// ===============================================
export default async function handler(request, response) {
  try {
    const movieId = request.query.id;
    const movieType = request.query.type || 'movie';
    if (!movieId) {
      return response.status(400).json({ message: 'Movie ID is required' });
    }

    const dbKey = `movie:${movieId}`;

    // 1. First, check the database (KV store)
    console.log(`Checking database for key: ${dbKey}`);
    let similarMovies = await kv.get(dbKey);

    // 2. If data is found, return it instantly! (Fast path)
    if (similarMovies) {
      console.log(`Cache hit for movie ${movieId}. Returning stored data.`);
      return response.status(200).json(similarMovies);
    }

    // 3. If data is NOT found, perform a live calculation (Smart path)
    console.log(`Cache miss for movie ${movieId}. Performing live calculation...`);
    
    // Fetch details for the requested movie
    const details = await fetchDetailsWithKeywords({ id: movieId, media_type: movieType });
    
    // Build the rich text document for the target movie
    const targetGenres = details.genres ? details.genres.map(g => g.name) : [];
    const targetRichText = [details.overview, ...Array(5).fill(targetGenres.join(' ')), ...Array(10).fill(details.keywords.join(' '))].join(' ');
    const targetTF = tf(tokenize(targetRichText));

    // Fetch candidates to compare against
    const candidateMovies = await tmdb('/discover/movie', { sort_by: 'vote_average.desc', 'vote_count.gte': 500, page: 1 });
    const candidates = candidateMovies.results;
    
    const allGenres = await tmdb('/genre/movie/list');
    const genreMap = new Map(allGenres.genres.map(g => [g.id, g.name]));

    // Perform the similarity calculation
    const corpTFs = candidates.map(c => {
        const candidateGenres = (c.genre_ids || []).map(id => genreMap.get(id) || '').filter(Boolean);
        const candidateRichText = [c.overview, ...Array(5).fill(candidateGenres.join(' '))].join(' ');
        return tf(tokenize(candidateRichText));
    });

    const allTFs = [targetTF, ...corpTFs];
    const { idf } = buildTfidf(allTFs);
    const tgtVec = vecFrom(targetTF, idf);
    
    let scored = candidates.map((c, i) => {
        const v = vecFrom(allTFs[i+1], idf);
        const score = cosine(tgtVec.v, tgtVec.norm, v.v, v.norm);
        return { item: c, score };
    }).filter(x => x.score > 0.05 && x.item.id !== details.id);
    
    scored.sort((a, b) => b.score - a.score);
    const top20Similar = scored.slice(0, 20);

    // 4. Save the new result to the database for next time
    // We use 'px' for expiration time in milliseconds. Set to 30 days.
    // 30 days * 24 hours * 60 minutes * 60 seconds * 1000 milliseconds
    console.log(`Saving new results for movie ${movieId} to database.`);
    await kv.set(dbKey, JSON.stringify(top20Similar), { px: 30 * 24 * 60 * 60 * 1000 });

    // 5. Return the newly calculated data to the user
    return response.status(200).json(top20Similar);

  } catch (error) {
    console.error(error);
    return response.status(500).json({ message: `Server error: ${error.message}` });
  }
}