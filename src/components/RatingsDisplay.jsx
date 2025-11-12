import { useState, useEffect } from 'react';
import StarRating from './StarRating'; // 我们将创建一个新的星级评分组件
// Utility function for robust JSON fetching and error handling
async function fetcher(url, options = {}) {
  const response = await fetch(url, options);

  // 1. Check if response is successful (2xx status codes)
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  // 2. Check if response is JSON (crucial to catch 404 HTML pages)
  if (!contentType || !contentType.includes("application/json")) {
    // If the content type is not JSON (e.g., text/html for a 404),
    // throw a specific error instead of failing on res.json().
    const text = await response.text();
    console.error("Non-JSON Response Content:", text);
    throw new Error("Server returned an invalid or non-JSON response.");
  }

  return response.json();
}

export default function RatingsDisplay({ modelId }) {
  const [ratings, setRatings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newRating, setNewRating] = useState(5); // Default to 5 stars
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Construct the API path inside the functions that use it to ensure it's always fresh.
  const getApiPath = () => modelId ? `/api/rating/${encodeURIComponent(modelId)}` : null;

  
  // -------------------------
  // 1. Fetch Ratings (GET)
  // -------------------------
  const fetchRatings = async () => {
    const path = getApiPath();
    if (!path) return;
    setLoading(true);
    try {
      const data = await fetcher(path);
      setRatings(data);
    } catch (err) {
      console.error('Fetch Error:', err);
      setError('Error loading ratings: ' + err.message); // Keep this for user feedback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRatings();
  }, [modelId]); // Re-fetch when the modelId prop changes.

  // -------------------------
  // 2. Submit Rating (POST)
  // -------------------------
  const handleSubmit = async (e) => {
    e.preventDefault();
    const path = getApiPath();
    if (!path || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await fetcher(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rating: newRating,
          comment: newComment,
          timestamp: Date.now(),
        }),
      });

      // Successful submission
      alert('Review submitted successfully!');
      
      // Update local state and refresh data
      setNewComment('');
      setNewRating(5);
      
      // Immediately fetch the updated ratings to show the new data 
      await fetchRatings(); 

    } catch (err) {
      console.error('Submit Error:', err);
      // The robust fetcher handles non-JSON responses, providing a clear error message here.
      setSubmitError('Submission failed: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!modelId) return <div>Model ID is missing.</div>;
  if (loading) return <div>Loading ratings...</div>;
  if (error) return <div style={{ color: 'red' }}>{error}</div>;

  const totalRatings = ratings?.total_ratings || 0;
  const averageRating = ratings?.average_rating || 0;
  const reviews = ratings?.comments || [];

  return (
    <div className="space-y-12 font-sans">
      {/* --- 1. 评分汇总 --- */}
      <div className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-200 dark:border-gray-700">
        <h3 className="text-2xl font-bold text-gray-900 dark:text-white">User Ratings</h3>
        <div className="flex items-center mt-4 space-x-4">
          <div className="flex items-baseline space-x-1">
            <span className="text-5xl font-extrabold text-blue-600 dark:text-blue-400">{averageRating.toFixed(1)}</span>
            <span className="text-xl font-medium text-gray-500 dark:text-gray-400">/ 5</span>
          </div>
          <div className="flex flex-col">
            <StarRating rating={averageRating} />
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Based on {totalRatings} ratings</p>
          </div>
        </div>
      </div>
      
      {/* Submission Form */}
      <div className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-200 dark:border-gray-700">
        <h4 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Leave a Review</h4>
        {submitError && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{submitError}</p>}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="rating-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Your Rating
            </label>
            <div className="relative">
              <select
                id="rating-select"
                value={newRating}
                onChange={(e) => setNewRating(Number(e.target.value))}
                disabled={submitting}
                className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition duration-150 ease-in-out appearance-none"
              >
                {[5, 4, 3, 2, 1].map(star => (
                  <option key={star} value={star}>{star} Star{star > 1 ? 's' : ''}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-700 dark:text-gray-300">
                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="comment-textarea" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Your Comment (optional)
            </label>
            <textarea
              id="comment-textarea"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              disabled={submitting}
              rows="4"
              placeholder="Share your thoughts about this model..."
              className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition duration-150 ease-in-out"
            />
          </div>

          <div>
            <button 
              type="submit" 
              disabled={submitting}
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-all duration-150 ease-in-out"
            >
              {submitting ? 'Submitting...' : 'Submit Review'}
            </button>
          </div>
        </form>
      </div>

      {/* Display Comments */}
      <div className="space-y-6">
        <h4 className="text-xl font-bold text-gray-900 dark:text-white">Comments ({totalRatings})</h4>
        {reviews.length === 0 ? (
          <div className="text-center py-10 px-6 bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-200 dark:border-gray-700">
            <p className="text-gray-500 dark:text-gray-400">Be the first to leave a review!</p>
          </div>
        ) : (
          <div className="space-y-6">
            {reviews.map((review, index) => (
            <div key={index} className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-200 dark:border-gray-700">
              <div className="flex items-start space-x-4">
                <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 font-bold">
                  U
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <StarRating rating={review.rating} />
                    <small className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(review.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </small>
                  </div>
                  <p className="mt-3 text-gray-700 dark:text-gray-300 leading-relaxed">
                    {review.comment || <span className="italic text-gray-400 dark:text-gray-500">No comment provided.</span>}
                  </p>
                </div>
              </div>
            </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}