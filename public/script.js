let scoredResults = [];

const $q = document.getElementById('query');
const $suggestions = document.getElementById('suggestions');
const $searchWrap = document.getElementById('searchWrap');
const $similarSection = document.getElementById('similarSection');
const $chosenTitle = document.getElementById('chosenTitle');
const $similarGrid = document.getElementById('similarGrid');
const $emptyMsg = document.getElementById('emptyMsg');
const $loader = document.getElementById('loader');
const $includeTmdb = document.getElementById('includeTmdb');
const $trailerModal = document.getElementById('trailerModal');
const $trailerFrame = document.getElementById('trailerFrame');
const $trailerCloseBtn = document.querySelector('.trailer-close');
const $storyModal = document.getElementById('storyModal');
const $storyTitle = document.getElementById('storyTitle');
const $storyOverview = document.getElementById('storyOverview');
const $storyCloseBtn = document.querySelector('.story-close');

const IMG = (path, size = "w185") => path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
function showLoader(v) { $loader.style.display = v ? 'flex' : 'none'; }

async function startStorySimilar(chosen, type) {
  type = type || (chosen.media_type || (chosen.first_air_date ? 'tv' : 'movie'));
  $chosenTitle.textContent = `Similar to: ${chosen.title || chosen.name}`;
  $similarGrid.innerHTML = '';
  $emptyMsg.style.display = 'none';
  showLoader(true);

  try {
    // UPDATED: We now pass the 'type' to the backend API
    const response = await fetch(`/api/get-similar?id=${chosen.id}&type=${type}`);
    const similarResults = await response.json();

    showLoader(false);

    if (similarResults && similarResults.length > 0) {
      scoredResults = similarResults;
      const frag = document.createDocumentFragment();
      similarResults.forEach((result, index) => {
        // The backend might return a direct TMDB item or our {item, score} object
        const item = result.item || result;
        const score = result.score || 0.1; // Assign a default score for fallbacks
        frag.appendChild(card(item, score, index))
      });
      $similarGrid.appendChild(frag);
    } else {
      $emptyMsg.textContent = "Similarity data for this title is not yet available. Our daily script will process it soon.";
      $emptyMsg.style.display = 'block';
    }

  } catch (err) {
    console.error(err);
    showLoader(false);
    alert('Failed to get similar movies. Please try again.');
  }
}

let debounceTimer; let activeIndex = -1;
function renderSuggestions(list) {
  if (!list.length) { hideSuggestions(); return; }
  $suggestions.innerHTML = '';
  list.slice(0, 10).forEach((m) => {
    const type = m.media_type || (m.first_air_date ? 'tv' : 'movie');
    const div = document.createElement('div');
    div.className = 's-item';
    div.innerHTML = `<div class="s-img-wrap"><img src="${IMG(m.poster_path)}" alt="poster" onerror="this.style.display='none'"/><div class="s-play-icon" data-id="${m.id}" data-type="${type}">&#9658;</div></div><div><div class="s-title">${m.title || m.name}</div><div class="s-sub">${type.toUpperCase()} · ${(m.release_date || m.first_air_date || '').slice(0, 4)}</div></div><button class="s-trailer-btn" data-id="${m.id}" data-type="${type}">Trailer</button>`;
    div.addEventListener('click', () => selectSuggestion(m));
    $suggestions.appendChild(div);
  });
  $suggestions.style.display = 'block';
  activeIndex = -1;
}
async function searchSuggest(q) {
  // This frontend API call will be replaced by a secure backend call later
  const apiKey = "29cc08fe366bb9bba8afa93b7d58a129";
  const url = `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${q}&include_adult=false`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv');
}
function hideSuggestions() { $suggestions.style.display = 'none'; $suggestions.innerHTML = ''; activeIndex = -1; }
function moveActive(dir) {
  const items = Array.from($suggestions.querySelectorAll('.s-item'));
  if (!items.length) return;
  activeIndex = (activeIndex + dir + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
}
function card(m, score, index) {
  const div = document.createElement('div');
  const year = (m.release_date || m.first_air_date || '').slice(0, 4);
  const type = m.media_type || (m.first_air_date ? 'tv' : 'movie');
  let badgeColor, badgeText;
  if (score > 0.4) { badgeColor = '#1f6feb'; badgeText = 'Excellent Match'; }
  else if (score > 0.25) { badgeColor = '#238636'; badgeText = 'Good Match'; }
  else { badgeColor = '#8B949E'; badgeText = 'Fair Match'; }
  div.className = 'card';
  div.innerHTML = `<div class="poster-wrap"><img class="poster" src="${IMG(m.poster_path)}" alt="Poster" loading="lazy" onerror="this.style.display='none'"><div class="trailer-btn" data-id="${m.id}" data-type="${type}" title="Watch Trailer">&#9658;</div></div><div class="meta"><div class="title">${m.title || m.name}</div><div class="sub">${type.toUpperCase()} · ${year} · ⭐ ${m.vote_average?.toFixed(1) || '—'}</div><div class="sub"><span class="match-badge" style="background-color:${badgeColor}">${badgeText}</span>(${(score * 100).toFixed(0)}%)</div><button class="story-btn" data-index="${index}">Read Story</button></div>`;
  return div;
}
async function playTrailer(id, type) {
  try {
    const apiKey = "29cc08fe366bb9bba8afa93b7d58a129";
    const url = `https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${apiKey}&language=en-US`;
    const res = await fetch(url);
    const data = await res.json();
    const trailer = data.results?.find(v => v.site === 'YouTube' && v.type === 'Trailer');
    if (trailer) {
      $trailerFrame.src = `https://www.youtube.com/embed/${trailer.key}?autoplay=1`;
      $trailerModal.style.display = 'block';
    } else { alert('Sorry, no official trailer found.'); }
  } catch (err) { alert('Could not fetch trailer data.'); }
}
function showStory(index) {
  const result = scoredResults[index];
  if (result) {
    const item = result.item || result;
    $storyTitle.textContent = item.title || item.name;
    $storyOverview.textContent = item.overview || "No story summary available.";
    $storyModal.style.display = 'block';
  }
}
$q.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = $q.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }
  debounceTimer = setTimeout(async () => {
    try { renderSuggestions(await searchSuggest(q)); } catch (e) { hideSuggestions(); }
  }, 300);
});
$q.addEventListener('keydown', (e) => {
  if ($suggestions.style.display === 'block') {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const items = Array.from($suggestions.querySelectorAll('.s-item'));
      if (items.length) {
        (items[activeIndex >= 0 ? activeIndex : 0]).click();
      }
    } else if (e.key === 'Escape') { hideSuggestions(); }
  }
});
document.addEventListener('click', (e) => { if (!$searchWrap.contains(e.target)) { hideSuggestions(); } });
$suggestions.addEventListener('click', (e) => {
  const interactiveElement = e.target.closest('.s-trailer-btn, .s-play-icon');
  if (interactiveElement) {
    e.stopPropagation();
    const { id, type } = interactiveElement.dataset;
    playTrailer(id, type);
    hideSuggestions();
  }
});
function afterSelectionUI(titleText) {
  $q.value = titleText;
  $q.blur();
  hideSuggestions();
  $similarSection.style.display = 'block';
  $similarSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function selectSuggestion(m) {
  const type = m.media_type || (m.first_air_date ? 'tv' : 'movie');
  startStorySimilar(m, type);
  afterSelectionUI(m.title || m.name);
}
$similarGrid.addEventListener('click', (e) => {
  const trailerButton = e.target.closest('.trailer-btn');
  if (trailerButton) {
    const { id, type } = trailerButton.dataset;
    playTrailer(id, type);
    return;
  }
  const storyButton = e.target.closest('.story-btn');
  if (storyButton) {
    const { index } = storyButton.dataset;
    showStory(index);
    return;
  }
});
function closeTrailerModal() { $trailerModal.style.display = 'none'; $trailerFrame.src = ''; }
function closeStoryModal() { $storyModal.style.display = 'none'; }
$trailerCloseBtn.addEventListener('click', closeTrailerModal);
$storyCloseBtn.addEventListener('click', closeStoryModal);
window.addEventListener('click', (e) => {
  if (e.target == $trailerModal) { closeTrailerModal(); }
  if (e.target == $storyModal) { closeStoryModal(); }
});