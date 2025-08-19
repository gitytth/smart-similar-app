import { kv } from '@vercel/kv';

export default async function handler(request, response) {
  try {
    // 1. Get the movie ID from the URL (e.g., /api/get-similar?id=123)
    const movieId = request.query.id;

    if (!movieId) {
      return response.status(400).json({ message: 'Movie ID is required' });
    }

    // 2. Fetch the pre-calculated list from the KV database
    // The key was stored as `movie:123`
    const similarMovies = await kv.get(`movie:${movieId}`);

    // 3. If no data is found, return an empty list
    if (!similarMovies) {
      return response.status(200).json([]);
    }

    // 4. If data is found, return it to the user's browser
    return response.status(200).json(similarMovies);
    
  } catch (error) {
    console.error(error);
    return response.status(500).json({ message: 'Server error' });
  }
}