import { kv } from '@vercel/kv';

// All helper functions (tmdb, tokenize, cosine, etc.) remain the same
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
async function tmdb(path, params = {}) { /* ... a lot of code ... */ } // Placeholder for brevity
const EN_STOP = new Set('a,an,and,are,as,at,be,by,for,from,has,he,in,is,it,its,of,on,that,the,they,this,to,was,were,with,will,his,her,have,not,or,if,into,over,after,before,also,about,them,than,then,when,while,who,whom,which,what,why,how,their,there,been,do,does,did,doing,up,down,out,off,again,further,more,most,other,own,same,so,too,very,can,just,should,now'.split(','));
function tokenize(txt) { if (!txt) return []; const clean = txt.toLowerCase().replace(/[^\p{L}\s]/gu, ' '); return clean.split(/\s+/).filter(t => t.length > 2 && !EN_STOP.has(t)); }
function tf(tokens) { const f = new Map(); tokens.forEach(t => f.set(t, (f.get(t) || 0) + 1)); return f; }
function buildTfidf(corpusTokens) { const df = new Map(); corpusTokens.forEach(tokMap => { const seen = new Set(tokMap.keys()); seen.forEach(t => df.set(t, (df.get(t) || 0) + 1)); }); const N = corpusTokens.length; const idf = new Map(); df.forEach((v, k) => idf.set(k, Math.log((N + 1) / (v + 1)) + 1)); return { idf }; }
function vecFrom(tfMap, idf) { const v = new Map(); let norm = 0; tfMap.forEach((count, term) => { const w = (1 + Math.log(count)) * (idf.get(term) || 0); v.set(term, w); norm += w * w; }); return { v, norm: Math.sqrt(norm) }; }
function cosine(v1, n1, v2, n2) { if (!n1 || !n2) return 0; let dot = 0; v1.forEach((w, t) => { const w2 = v2.get(t); if (w2) dot += w * w2; }); return dot / (n1 * n2); }
async function fetchDetailsWithKeywords(item) {
    const type = item.media_type || 'movie';
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
// Keep all the helper functions from the previous version, paste them here.
// For brevity, I am only showing the main handler function that has changed.

// ===============================================
// THE NEW, FASTER CRON JOB HANDLER
// ===============================================
export default async function handler(request, response) {
  try {
    // --- 1. Get the current position we're processing ---
    let position = await kv.get('cron_position') || { page: 1, index: 0 };
    
    // --- 2. Fetch the current page of popular movies ---
    const popularMoviesResponse = await tmdb('/movie/popular', { page: position.page });
    const popularMovies = popularMoviesResponse.results;

    if (!popularMovies || popularMovies.length === 0) {
      await kv.set('cron_position', { page: 1, index: 0 }); // Reset if we run out of pages
      return response.status(200).send('Finished all pages, resetting.');
    }

    // --- 3. Get the SINGLE movie to process ---
    if (position.index >= popularMovies.length) {
      // If we finished a page, move to the next page
      position.page += 1;
      position.index = 0;
      await kv.set('cron_position', position);
      return response.status(200).send(`Finished page ${position.page - 1}. Moving to next page.`);
    }
    const movieToProcess = popularMovies[position.index];
    movieToProcess.media_type = 'movie';

    // --- 4. Fetch candidates to compare against (same as before) ---
    const candidateMovies = await tmdb('/discover/movie', { sort_by: 'vote_average.desc', 'vote_count.gte': 500, page: 1 });
    const candidates = candidateMovies.results;
    
    const allGenres = await tmdb('/genre/movie/list');
    const genreMap = new Map(allGenres.genres.map(g => [g.id, g.name]));

    // --- 5. Run the Smart Similarity logic for this ONE movie ---
    const details = await fetchDetailsWithKeywords(movieToProcess);
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
        return { item: c, score };
    }).filter(x => x.score > 0.05 && x.item.id !== movieToProcess.id);
    
    scored.sort((a, b) => b.score - a.score);
    const top20Similar = scored.slice(0, 20);

    // --- 6. Save the result to the database ---
    await kv.set(`movie:${movieToProcess.id}`, JSON.stringify(top20Similar));
    
    // --- 7. Update the position for the next run ---
    position.index += 1;
    await kv.set('cron_position', position);

    const message = `Successfully processed: ${movieToProcess.title} (Page: ${position.page}, Index: ${position.index - 1})`;
    console.log(message);
    response.status(200).send(message);

  } catch (error) {
    console.error(error);
    response.status(500).send(`An error occurred: ${error.message}`);
  }
}