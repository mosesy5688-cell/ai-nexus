import { useState, useEffect } from 'react';
import StarRating from '@/components/StarRating.astro'; // Assuming this component is still needed for display
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
  const [newComment, setNewComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

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
    <div className="font-sans">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
        {/* --- 1. Ratings Summary (Left Column) --- */}
        <div className="md:col-span-1 p-6 bg-input-background/50 rounded-2xl border border-card-border flex flex-col items-center justify-center text-center shadow-md">
          <h3 className="text-2xl font-bold text-foreground">User Ratings</h3>
          <div className="flex items-baseline mt-4 space-x-2">
            <span className="text-6xl font-extrabold text-primary">{averageRating > 0 ? averageRating.toFixed(1) : 'N/A'}</span>
            {averageRating > 0 && <span className="text-2xl font-medium text-muted-foreground">/ 5</span>}
          </div>
          <div className="mt-2">
            <StarRating rating={averageRating} size="h-6 w-6" />
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Based on {totalRatings} ratings</p>
        </div>

        {/* --- 2. Submission Form (Right Column) --- */}
        <div className="md:col-span-2 p-6 bg-card-background rounded-2xl shadow-lg border border-card-border">
          <h4 className="text-xl font-bold text-foreground mb-4">Leave a Review</h4>
          {submitError && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{submitError}</p>}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="rating-select" className="block text-sm font-medium text-muted-foreground mb-2">
                Your Rating
              </label>
              <div className="flex space-x-1">
                {[5, 4, 3, 2, 1].map((star) => (
                  <button
                    type="button"
                    key={star}
                    onClick={() => setNewRating(star)}
                    className={`text-3xl transition-transform duration-150 ease-in-out ${newRating >= star ? 'text-yellow-400 scale-110' : 'text-gray-400 dark:text-gray-600'} hover:scale-125`}
                    aria-label={`Rate ${star} stars`}
                    disabled={submitting}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="comment-textarea" className="block text-sm font-medium text-muted-foreground mb-2">
                Your Comment (optional)
              </label>
              <textarea
                id="comment-textarea"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                disabled={submitting}
                rows="4"
                placeholder="Share your experience with this model..."
                className="w-full px-4 py-2 bg-input-background border border-input-border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition duration-150 ease-in-out"
              />
            </div>

            <div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:bg-gray-400 dark:disabled:bg-gray-600 disabled:cursor-not-allowed transition-all duration-150 ease-in-out"
              >
                {submitting ? 'Submitting...' : 'Submit Review'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* --- 3. Display Comments --- */}
      <div className="mt-12">
        <h4 className="text-2xl font-bold text-foreground mb-6">Comments ({reviews.length})</h4>
        {reviews.length === 0 ? (
          <div className="text-center py-12 px-6 bg-input-background/50 rounded-2xl border-2 border-dashed border-card-border">
            <p className="text-muted-foreground">Be the first to leave a review!</p>
          </div>
        ) : (
          <div className="space-y-6">
            {reviews.map((review, index) => (
              <div key={index} className="p-6 bg-card-background rounded-xl shadow-md border border-card-border">
                <div className="flex items-center justify-between">
                  <StarRating rating={review.rating} />
                  <small className="text-xs text-muted-foreground">
                    {new Date(review.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                  </small>
                </div>
                <p className="mt-4 text-foreground/90 leading-relaxed">
                  {review.comment || <span className="italic text-muted-foreground">No comment provided.</span>}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}