import { useState, useEffect } from 'react';

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

  // The model ID contains slashes (e.g., "meta-llama--Meta-Llama-3-8B-Instruct").
  // We must URL-encode it to ensure it's treated as a single URL segment.
  const safeModelId = encodeURIComponent(modelId);

  const apiPath = safeModelId ? `/api/rating/${safeModelId}` : null;
  
  // -------------------------
  // 1. Fetch Ratings (GET)
  // -------------------------
  const fetchRatings = async () => {
    if (!apiPath) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetcher(apiPath);
      setRatings(data);
    } catch (err) {
      console.error('Fetch Error:', err);
      setError('Error loading ratings: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRatings();
  }, [apiPath]);

  // -------------------------
  // 2. Submit Rating (POST)
  // -------------------------
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!apiPath || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await fetcher(apiPath, {
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

  const totalRatings = ratings?.reviews?.length || 0;
  const averageRating = ratings?.averageRating || 0;
  const reviews = ratings?.reviews || [];

  return (
    <div>
      <h3>User Ratings & Comments</h3>
      <p>{averageRating.toFixed(1)} / 5 ({totalRatings} ratings)</p>

      {/* Submission Form */}
      <div className="review-form">
        <h4>Leave a Review</h4>
        {submitError && <p style={{ color: 'red' }}>{submitError}</p>}
        <form onSubmit={handleSubmit}>
          <label>
            Your Rating:
            <select
              value={newRating}
              onChange={(e) => setNewRating(Number(e.target.value))}
              disabled={submitting}
            >
              {[1, 2, 3, 4, 5].map(star => (
                <option key={star} value={star}>{star} Star{star > 1 ? 's' : ''}</option>
              ))}
            </select>
          </label>
          <br />
          <label>
            Your Comment (optional):
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              disabled={submitting}
              rows="3"
            />
          </label>
          <br />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit Review'}
          </button>
        </form>
      </div>

      {/* Display Comments */}
      <div className="comments-list">
        <h4>Comments ({totalRatings})</h4>
        {reviews.length === 0 ? (
          <p>Be the first to leave a comment!</p>
        ) : (
          reviews.map((review, index) => (
            <div key={index} className="comment-item">
              <p><strong>Rating:</strong> {review.rating} / 5</p>
              <p>{review.comment}</p>
              <small>{new Date(review.timestamp).toLocaleDateString()}</small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}