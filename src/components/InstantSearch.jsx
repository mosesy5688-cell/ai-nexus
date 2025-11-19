import React, { useState, useEffect, useRef } from 'react';
import algoliasearch from 'algoliasearch/lite';
import { algoliaConfig } from '../config';

const searchClient = algoliasearch(algoliaConfig.appId, algoliaConfig.searchKey);
const index = searchClient.initIndex(algoliaConfig.indexName);

function Hit({ hit }) {
  const modelUrl = `/model/${hit.id.replace(/\//g, '--')}`;
  return (
    <a href={modelUrl} className="block p-3 hover:bg-gray-100 rounded-md transition-colors">
      <h3 className="font-semibold text-gray-800 truncate">{hit.name}</h3>
      <p className="text-sm text-gray-500 truncate">{hit.description || 'No description'}</p>
    </a>
  );
}

export default function InstantSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isFocused, setIsFocused] = useState(false);
  const searchContainerRef = useRef(null);

  useEffect(() => {
    if (query.length > 1) {
      const timer = setTimeout(() => {
        index.search(query, { hitsPerPage: 8 }).then(({ hits }) => {
          setResults(hits);
        });
      }, 300); // Debounce search
      return () => clearTimeout(timer);
    } else {
      setResults([]);
    }
  }, [query]);

  // Handle clicks outside the search component to close the results
  useEffect(() => {
    function handleClickOutside(event) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        setIsFocused(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [searchContainerRef]);

  const showResults = isFocused && results.length > 0;

  return (
    <div className="relative max-w-2xl mx-auto" ref={searchContainerRef}>
      <form action="/explore" method="get" className="relative">
        <input
          type="search"
          name="q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsFocused(true)}
          placeholder="Search for AI models, tools, or keywords..."
          className="w-full p-4 pl-12 text-lg border border-gray-300 rounded-full bg-white focus:ring-blue-500 focus:border-blue-500 shadow-lg"
          autoComplete="off"
        />
        <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
          <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
        </div>
        <button type="submit" className="absolute inset-y-0 right-0 flex items-center px-6 bg-blue-600 text-white font-semibold rounded-r-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
          Search
        </button>
      </form>

      {showResults && (
        <div className="absolute z-50 w-full mt-2 bg-white border border-gray-200 rounded-lg shadow-xl">
          <ul className="divide-y divide-gray-100">
            {results.map(hit => (
              <li key={hit.objectID}>
                <Hit hit={hit} />
              </li>
            ))}
          </ul>
          {query && (
            <a href={`/explore?q=${encodeURIComponent(query)}`} className="block w-full p-3 text-center font-semibold text-blue-600 bg-gray-50 hover:bg-gray-100 rounded-b-lg">
              View all results for "{query}"
            </a>
          )}
        </div>
      )}
    </div>
  );
}