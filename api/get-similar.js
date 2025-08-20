import { kv } from '@vercel/kv';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";

// Simple helper to fetch from TMDB
async function tmdb(path, params = {}) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const key in params) {
    url.searchParams.set(key, params[key]);
  }
  const res = await fetch(url);
  if (!res.ok) {
    // Return null instead of throwing an error, so Promise.all doesn't fail completely
    return null; 
  }
  return res.json();
}

// ===============================================
// THE FINAL "SMART AGGREGATOR" HANDLER
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

    // 2. If not in DB, perform the new "Smart Aggregator" on-demand calculation
    console.log(`Cache miss for ${dbKey}. Performing Smart Aggregation...`);

    // Perform 3 API calls in parallel for maximum speed
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

    // Combine all results into one big list
    const combined = [
      ...(similarRes?.results || []),
      ...(recommendationsRes?.results || []),
      ...keywordResults
    ];

    // Remove duplicate results using a Map
    const uniqueResults = [
      ...new Map(combined.map((item) => [item["id"], item])).values(),
    ];
    
    // Filter out the original item itself and items without posters
    const finalResults = uniqueResults.filter(item => item.id != id && item.poster_path);

    // Give a default "score" to each item so the frontend can display it
    // We can be smarter here, e.g., giving higher scores to items from the "similar" list
    const scoredResults = finalResults.map(item => {
        item.media_type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
        // A simple scoring based on popularity
        const score = Math.min(item.popularity / 500, 0.5) || 0.1;
        return { item, score };
    });

    // Sort by our new simple score
    scoredResults.sort((a, b) => b.score - a.score);

    const topResults = scoredResults.slice(0, 50);

    // Save the new, rich list to the database for next time
    if (topResults.length > 0) {
      await kv.set(dbKey, topResults, { ex: 60 * 60 * 24 * 30 }); // Expires in 30 days
    }

    return response.status(200).json(topResults);

  } catch (error) {
    console.error(`Error during smart aggregation for ${dbKey}: ${error.message}`);
    // If even this fails, return an empty list gracefully
    return response.status(500).json([]);
  }
}