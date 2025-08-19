import { kv } from '@vercel/kv';

// NOTE: This is the full backend logic inside the cron job.
// It includes all the smart similarity functions.

// ===============================================
// HELPER FUNCTIONS (TMDB API & Text Processing)
// ===============================================

const TMDB_API_KEY = process.env.TMDB_API_KEY; // Securely get the API key
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

async function fetchDetailsWithKeywords(item) {
  const type = item.media_type;
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
// THE MAIN CRON JOB HANDLER
// ===============================================
export default async function handler(request, response) {
  try {
    // --- 1. Get a batch of movies to process ---
    // We get the current page number from KV, or start at 1.
    let currentPage = await kv.get('processed_movies_page') || 1;
    
    // Fetch one page of popular movies from TMDB.
    const popularMovies = await tmdb('/movie/popular', { page: currentPage });
    if (!popularMovies.results || popularMovies.results.length === 0) {
      // If we've run out of pages, reset to 1 for the next day.
      await kv.set('processed_movies_page', 1);
      return response.status(200).send('No more movies to process. Resetting for tomorrow.');
    }

    // --- 2. Get all candidates to compare against ---
    // For this batch, we'll compare against a fixed set of highly-rated movies.
    const candidateMovies = await tmdb('/discover/movie', {
      sort_by: 'vote_average.desc',
      'vote_count.gte': 500, // only well-known movies
      page: 1
    });
    const candidateTV = await tmdb('/discover/tv', {
        sort_by: 'vote_average.desc',
        'vote_count.gte': 500,
        page: 1
    });
    const candidates = [...candidateMovies.results, ...candidateTV.results];

    // --- 3. Get Genre Data ---
    const movieGenres = await tmdb('/genre/movie/list');
    const tvGenres = await tmdb('/genre/tv/list');
    const genreMap = new Map([...movieGenres.genres, ...tvGenres.genres].map(g => [g.id, g.name]));

    // --- 4. Process each movie in the batch ---
    for (const movie of popularMovies.results) {
      movie.media_type = 'movie'; // Add media_type for consistency
      const details = await fetchDetailsWithKeywords(movie);
      
      const targetGenres = details.genres ? details.genres.map(g => g.name) : [];
      const targetRichText = [details.overview, ...Array(5).fill(targetGenres.join(' ')), ...Array(10).fill(details.keywords.join(' '))].join(' ');
      const targetTF = tf(tokenize(targetRichText));

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
        return { ...c, score }; // Combine item and score
      }).filter(x => x.score > 0.05 && x.id !== movie.id);
      
      scored.sort((a, b) => b.score - a.score);

      const top20Similar = scored.slice(0, 20);

      // --- 5. Save the results to the database ---
      // The key will be `movie:12345`
      // The value will be the list of 20 similar movies.
      await kv.set(`movie:${movie.id}`, JSON.stringify(top20Similar));
      console.log(`Processed and saved similarities for: ${movie.title}`);
    }

    // --- 6. Update the page number for the next run ---
    await kv.set('processed_movies_page', currentPage + 1);

    response.status(200).send(`Successfully processed page ${currentPage}.`);

  } catch (error) {
    console.error(error);
    response.status(500).send('An error occurred during the cron job.');
  }
}