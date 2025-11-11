import React, { useState, useEffect, useCallback } from 'react';

function Star({ filled, onClick }) {
    return (
        <svg
            onClick={onClick}
            className={`w-6 h-6 cursor-pointer ${filled ? 'text-yellow-400' : 'text-gray-300 dark:text-gray-600'}`}
            fill="currentColor"
            viewBox="0 0 20 20"
        >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
    );
}

export default function RatingsDisplay({ modelId, apiEndpoint }) {
    const [data, setData] = useState({ average_rating: 0, total_ratings: 0, comments: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [userRating, setUserRating] = useState(0);
    const [userComment, setUserComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitMessage, setSubmitMessage] = useState('');

    const fetchData = useCallback(async () => {
        try {
            const response = await fetch(apiEndpoint);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();
            setData(result);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [apiEndpoint]);

    useEffect(() => {
        fetchData();
    }, [fetchData, modelId]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (userRating === 0) {
            setSubmitMessage('Please select a rating.');
            return;
        }
        setIsSubmitting(true);
        setSubmitMessage('');

        try {
            const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating: userRating, comment: userComment }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Failed to submit rating.');
            }

            setSubmitMessage('Thank you for your feedback!');
            setUserRating(0);
            setUserComment('');
            // Refresh data after a successful submission
            setTimeout(fetchData, 1000);
        } catch (err) {
            setSubmitMessage(err.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (loading) return <p>Loading ratings...</p>;
    if (error) return <p>Error loading ratings: {error}</p>;

    return (
        <div>
            <div className="flex items-center gap-4 mb-6">
                <div className="flex items-center">
                    {[1, 2, 3, 4, 5].map((star) => (
                        <Star key={star} filled={star <= data.average_rating} />
                    ))}
                </div>
                <div className="text-lg">
                    <span className="font-bold">{data.average_rating}</span>
                    <span className="text-gray-500 dark:text-gray-400"> / 5</span>
                    <span className="ml-2 text-gray-500 dark:text-gray-400">({data.total_ratings} ratings)</span>
                </div>
            </div>

            <div className="my-8 p-6 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-xl font-semibold mb-4">Leave a Review</h3>
                <form onSubmit={handleSubmit}>
                    <div className="mb-4">
                        <label className="block mb-2 font-medium">Your Rating:</label>
                        <div className="flex">
                            {[1, 2, 3, 4, 5].map((star) => (
                                <Star key={star} filled={star <= userRating} onClick={() => setUserRating(star)} />
                            ))}
                        </div>
                    </div>
                    <div className="mb-4">
                        <label htmlFor="comment" className="block mb-2 font-medium">Your Comment (optional):</label>
                        <textarea
                            id="comment"
                            value={userComment}
                            onChange={(e) => setUserComment(e.target.value)}
                            className="w-full p-2 border rounded bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600"
                            rows="3"
                        ></textarea>
                    </div>
                    <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400">
                        {isSubmitting ? 'Submitting...' : 'Submit Review'}
                    </button>
                    {submitMessage && <p className={`mt-4 text-sm ${submitMessage.startsWith('Error') ? 'text-red-500' : 'text-green-500'}`}>{submitMessage}</p>}
                </form>
            </div>

            <div>
                <h3 className="text-xl font-semibold mb-4">Comments ({data.comments.length})</h3>
                <div className="space-y-4">
                    {data.comments.length > 0 ? (
                        data.comments.map((c, index) => (
                            <div key={index} className="p-4 border-b border-gray-200 dark:border-gray-700">
                                <div className="flex items-center mb-1">
                                    {[1, 2, 3, 4, 5].map((star) => <Star key={star} filled={star <= c.rating} />)}
                                </div>
                                <p className="text-gray-800 dark:text-gray-200">{c.comment}</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{new Date(c.timestamp).toLocaleString()}</p>
                            </div>
                        ))
                    ) : (
                        <p>Be the first to leave a comment!</p>
                    )}
                </div>
            </div>
        </div>
    );
}