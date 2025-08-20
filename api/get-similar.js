import { kv } from '@vercel/kv';

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
  if (!res.ok) {
    return null; 
  }
  return res.json();
}

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

    // 2. If not in DB, perform the "Smart Aggregator" on-demand calculation
    console.log(`Cache miss for ${dbKey}. Performing Smart Aggregation...`);

    const [similarRes, recommendationsRes, keywordsRes] = await Promise.all([
      tmdb(`/${type}/${id}/similar`),
      tmdb(`/${type}/${id}/recommendations`),
      tmdb(`/${type}/${id}/keywords`)
    ]);

    let keywordResults = [];
    if (keywordsRes) {
      const keywords = (keywordsRes.keywords || keywordsRes.results || []).slice(0, 3).map(k => k.id);
      if (keywords.length > 0) {
        const keywordSearchRes = await tmdb(`/discover/${type}`, { with_keywords: keywords.join(',') });
        if (keywordSearchRes) {
            keywordResults = keywordSearchRes.results || [];
        }
      }
    }

    const combined = [
      ...(similarRes?.results || []),
      ...(recommendationsRes?.results || []),
      ...keywordResults
    ];

    const uniqueResults = [
      ...new Map(combined.map((item) => [item["id"], item])).values(),
    ];
    
    const finalResults = uniqueResults.filter(item => item.id != id && item.poster_path);

    const scoredResults = finalResults.map(item => {
        item.media_type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
        const score = Math.min(item.popularity / 500, 0.5) || 0.1;
        return { item, score };
    });

    scoredResults.sort((a, b) => b.score - a.score);
    const topResults = scoredResults.slice(0, 50);

    // Save the new, rich list to the database for next time
    if (topResults.length > 0) {
      // THE ONLY CHANGE IS HERE: We changed the expiration from 30 days to 1 day.
      await kv.set(dbKey, topResults, { ex: 60 * 60 * 24 }); // Expires in 24 hours
    }

    return response.status(200).json(topResults);

  } catch (error) {
    console.error(`Error during smart aggregation for ${dbKey}: ${error.message}`);
    return response.status(500).json([]);
  }
}