const TMDB_API_KEY = "29cc08fe366bb9bba8afa93b7d58a129";
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG = (path, size = "w342") => path ? `https://image.tmdb.org/t/p/${size}${path}` : "";

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


function showLoader(v){ $loader.style.display = v ? 'flex' : 'none'; }

async function tmdb(path, params = {}, lang = 'en-US'){
  const url = new URL(TMDB_BASE + path);
  const defaults = { api_key: TMDB_API_KEY, language: lang };
  Object.entries({ ...defaults, ...params }).forEach(([k,v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if(!res.ok) throw new Error('TMDB error '+res.status);
  return res.json();
}

let debounceTimer; let activeIndex = -1;

function renderSuggestions(list){
  if(!list.length){ $suggestions.style.display='none'; $suggestions.innerHTML=''; activeIndex=-1; return; }
  $suggestions.innerHTML = '';
  list.slice(0,12).forEach((m, idx)=>{
    const type = m.media_type || (m.first_air_date ? 'tv' : 'movie');
    const div = document.createElement('div');
    div.className = 's-item';
    div.setAttribute('role','option');
    div.dataset.index = String(idx);
    
    div.innerHTML = `
      <div class="s-img-wrap">
        <img src="${IMG(m.poster_path,'w185')}" alt="poster" onerror="this.style.display='none'"/>
        <div class="s-play-icon" data-id="${m.id}" data-type="${type}">&#9658;</div>
      </div>
      <div>
        <div class="s-title">${m.title || m.name}</div>
        <div class="s-sub">${type.toUpperCase()} · ${(m.release_date||m.first_air_date||'').slice(0,4)}</div>
      </div>
      <button class="s-trailer-btn" data-id="${m.id}" data-type="${type}">Trailer</button>
    `;
    
    div.addEventListener('click', ()=> selectSuggestion(m));
    $suggestions.appendChild(div);
  });
  $suggestions.style.display='block';
  activeIndex = -1;
}

async function searchSuggest(q){
  const data = await tmdb('/search/multi', { query: q, include_adult: false });
  return (data.results||[]).filter(x=> x.media_type==='movie' || x.media_type==='tv');
}
function hideSuggestions(){ $suggestions.style.display='none'; $suggestions.innerHTML=''; activeIndex=-1; }
function moveActive(dir){
  const items = Array.from($suggestions.querySelectorAll('.s-item'));
  if(!items.length) return;
  activeIndex = (activeIndex + dir + items.length) % items.length;
  items.forEach((el,i)=> el.classList.toggle('active', i===activeIndex));
}

$q.addEventListener('input', ()=>{
  clearTimeout(debounceTimer);
  const q = $q.value.trim();
  if(q.length < 2){ hideSuggestions(); return; }
  debounceTimer = setTimeout(async()=>{
    try{ renderSuggestions(await searchSuggest(q)); }catch(e){ hideSuggestions(); }
  }, 300);
});
$q.addEventListener('keydown', (e)=>{
  if($suggestions.style.display==='block'){
    if(e.key==='ArrowDown'){ e.preventDefault(); moveActive(1); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); moveActive(-1); }
    else if(e.key==='Enter'){ e.preventDefault();
      const items = Array.from($suggestions.querySelectorAll('.s-item'));
      if(items.length){
        const idx = activeIndex>=0? activeIndex : 0;
        items[idx].click();
      }
    } else if(e.key==='Escape'){ hideSuggestions(); }
  }
});
document.addEventListener('click', (e)=>{
  if(!$searchWrap.contains(e.target)){ hideSuggestions(); }
});

$suggestions.addEventListener('click', (e) => {
    const interactiveElement = e.target.closest('.s-trailer-btn, .s-play-icon');

    if (interactiveElement) {
        e.stopPropagation(); // VERY IMPORTANT: Prevents the whole item from being selected
        const { id, type } = interactiveElement.dataset;
        playTrailer(id, type);
        hideSuggestions();
    }
});

function afterSelectionUI(titleText){
  $q.value = titleText;
  $q.blur();
  hideSuggestions();
  $similarSection.style.display='block';
  $similarSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function selectSuggestion(m){
  const type = m.media_type || (m.first_air_date? 'tv':'movie');
  startStorySimilar(m, type);
  afterSelectionUI(m.title || m.name);
}

const EN_STOP = new Set('a,an,and,are,as,at,be,by,for,from,has,he,in,is,it,its,of,on,that,the,they,this,to,was,were,with,will,his,her,have,not,or,if,into,over,after,before,also,about,them,than,then,when,while,who,whom,which,what,why,how,their,there,been,do,does,did,doing,up,down,out,off,again,further,more,most,other,own,same,so,too,very,can,just,should,now'.split(','));
function tokenize(txt){ if(!txt) return []; const clean = txt.toLowerCase().replace(/[^\p{L}\s]/gu,' '); return clean.split(/\s+/).filter(t=> t.length>2 && !EN_STOP.has(t)); }
function tf(tokens){ const f = new Map(); tokens.forEach(t=>f.set(t,(f.get(t)||0)+1)); return f; }
function buildTfidf(corpusTokens){ const df = new Map(); corpusTokens.forEach(tokMap=>{ const seen = new Set(tokMap.keys()); seen.forEach(t=> df.set(t, (df.get(t)||0)+1)); }); const N = corpusTokens.length; const idf = new Map(); df.forEach((v,k)=> idf.set(k, Math.log((N+1) / (v+1)) + 1)); return { idf }; }
function vecFrom(tfMap, idf){ const v = new Map(); let norm = 0; tfMap.forEach((count, term)=>{ const w = (1 + Math.log(count)) * (idf.get(term)||0); v.set(term, w); norm += w*w; }); return { v, norm: Math.sqrt(norm) }; }
function cosine(v1, n1, v2, n2){ if(!n1 || !n2) return 0; let dot = 0; v1.forEach((w, t)=>{ const w2 = v2.get(t); if(w2) dot += w*w2; }); return dot / (n1*n2); }

async function fetchDetails(item, type){ 
    const path = type==='movie' ? `/movie/${item.id}` : `/tv/${item.id}`;
    const [details, keywordsResponse] = await Promise.all([
        tmdb(path, {} , 'en-US'),
        tmdb(`${path}/keywords`)
    ]);

    let keywords = [];
    if (keywordsResponse.keywords) {
        keywords = keywordsResponse.keywords.map(k => k.name);
    } else if (keywordsResponse.results) {
        keywords = keywordsResponse.results.map(k => k.name);
    }
    
    return { details, keywords };
}

async function collectCandidates(item, type, keywords, includeTmdbSeeds){ const seen = new Set(); const out = []; function pushList(arr, media_type){ for(const m of arr||[]){ const id = media_type+':'+m.id; if(seen.has(id)) continue; seen.add(id); if(m.overview && m.overview.length>20){ m.media_type = media_type; out.push(m); } } } const genres = (item.genre_ids && item.genre_ids.length) ? item.genre_ids : (item.genres||[]).map(g=>g.id); const genreStr = (genres||[]).slice(0,3).join(','); const tasks = []; const pages = [1,2,3]; if(genreStr){ pages.forEach(p=> tasks.push(tmdb('/discover/movie', { with_genres: genreStr, page: p }))); pages.forEach(p=> tasks.push(tmdb('/discover/tv', { with_genres: genreStr, page: p }))); } pages.slice(0,2).forEach(p=> tasks.push(tmdb('/trending/movie/week', { page: p }))); pages.slice(0,2).forEach(p=> tasks.push(tmdb('/trending/tv/week', { page: p }))); if(keywords && keywords.length){ const kwStr = keywords.slice(0, 5).join(','); pages.forEach(p => tasks.push(tmdb('/discover/movie', { with_keywords: kwStr, page: p }))); pages.forEach(p => tasks.push(tmdb('/discover/tv', { with_keywords: kwStr, page: p }))); } if(includeTmdbSeeds){ const base = type==='movie'? '/movie/':'/tv/'; pages.forEach(p=> tasks.push(tmdb(`${base}${item.id}/similar`, { page: p }))); pages.forEach(p=> tasks.push(tmdb(`${base}${item.id}/recommendations`, { page: p }))); } const results = await Promise.allSettled(tasks); for(const r of results){ if(r.status==='fulfilled'){ const val = r.value; if(Array.isArray(val.results)){ const sample = val.results[0]; if(sample && (sample.title || sample.name)){ const mediaType = (sample.first_air_date !== undefined && sample.title === undefined) ? 'tv' : 'movie'; pushList(val.results, mediaType); } } } } return out.slice(0, 400); }

async function startStorySimilar(chosen, type){
  type = type || (chosen.media_type || (chosen.first_air_date ? 'tv' : 'movie'));
  $chosenTitle.textContent = `Similar to: ${chosen.title || chosen.name}`;
  $similarGrid.innerHTML = '';
  $emptyMsg.style.display = 'none';
  showLoader(true);
  try{
    const { details, keywords } = await fetchDetails(chosen, type);
    
    const targetGenres = details.genres ? details.genres.map(g => g.name) : [];
    const targetRichText = [
        details.overview,
        ...Array(5).fill(targetGenres.join(' ')),
        ...Array(10).fill(keywords.join(' '))
    ].join(' ');

    const targetTokens = tokenize(targetRichText);
    const targetTF = tf(targetTokens);

    const candidates = await collectCandidates(details, type, keywords, $includeTmdb.checked);
    if(!candidates.length){ showLoader(false); $emptyMsg.style.display='block'; return; }

    const allGenres = await tmdb('/genre/movie/list');
    const tvGenres = await tmdb('/genre/tv/list');
    allGenres.genres.push(...tvGenres.genres);
    const genreMap = new Map(allGenres.genres.map(g => [g.id, g.name]));

    const corpTokens = candidates.map(c => {
        const candidateGenres = (c.genre_ids || []).map(id => genreMap.get(id) || '').filter(Boolean);
        const candidateRichText = [
            c.overview,
            ...Array(5).fill(candidateGenres.join(' '))
        ].join(' ');
        return tf(tokenize(candidateRichText));
    });

    const allTFs = [targetTF, ...corpTokens];
    const { idf } = buildTfidf(allTFs);
    const tgtVec = vecFrom(targetTF, idf);
    
    let scored = candidates.map((c, i)=>{
      const v = vecFrom(allTFs[i+1], idf);
      const score = cosine(tgtVec.v, tgtVec.norm, v.v, v.norm);
      return { item: c, score };
    }).filter(x=> x.score > 0.05);
    
    scored.sort((a,b)=> b.score - a.score);

    scoredResults = scored.slice(0, 100);

    const frag = document.createDocumentFragment();
    scoredResults.forEach(({item, score}, index) => frag.appendChild(card(item, score, index)));
    $similarGrid.appendChild(frag);
    showLoader(false);
  }catch(err){
    console.error(err);
    showLoader(false);
    alert('Failed to build smart similarity list. Check network/API key.');
  }
}

function card(m, score, index){
  const div = document.createElement('div');
  const year = (m.release_date||m.first_air_date||'').slice(0,4);
  const type = (m.media_type || (m.first_air_date?'tv':'movie'));

  let badgeColor, badgeText;
  if (score > 0.4) {
      badgeColor = '#1f6feb';
      badgeText = 'Excellent Match';
  } else if (score > 0.25) {
      badgeColor = '#238636';
      badgeText = 'Good Match';
  } else {
      badgeColor = '#8B949E';
      badgeText = 'Fair Match';
  }

  div.className = 'card';
  div.innerHTML = `
    <div class="poster-wrap">
      <img class="poster" src="${IMG(m.poster_path)}" alt="Poster" loading="lazy" onerror="this.style.display='none'">
      <div class="trailer-btn" data-id="${m.id}" data-type="${type}" title="Watch Trailer">&#9658;</div>
    </div>
    <div class="meta">
      <div class="title">${m.title || m.name}</div>
      <div class="sub">${type.toUpperCase()} · ${year} · ⭐ ${m.vote_average?.toFixed(1) || '—'}</div>
      <div class="sub">
        <span class="match-badge" style="background-color:${badgeColor}">${badgeText}</span>
        (${(score*100).toFixed(0)}%)
      </div>
      <button class="story-btn" data-index="${index}">Read Story</button>
    </div>`;
  return div;
}

async function playTrailer(id, type) {
  try {
    const data = await tmdb(`/${type}/${id}/videos`);
    const trailer = data.results?.find(v => v.site === 'YouTube' && v.type === 'Trailer');
    if (trailer) {
      $trailerFrame.src = `https://www.youtube.com/embed/${trailer.key}?autoplay=1`;
      $trailerModal.style.display = 'block';
    } else {
      alert('Sorry, no official trailer found.');
    }
  } catch (err) {
    console.error('Failed to fetch trailer:', err);
    alert('Could not fetch trailer data.');
  }
}

function showStory(index) {
    const result = scoredResults[index];
    if (result) {
        $storyTitle.textContent = result.item.title || result.item.name;
        $storyOverview.textContent = result.item.overview || "No story summary available.";
        $storyModal.style.display = 'block';
    }
}

$similarGrid.addEventListener('click', (e) => {
  const trailerButton = e.target.closest('.trailer-btn');
  if (trailerButton) {
    const { id, type } = trailerButton.dataset;
    playTrailer(id, type);
    return;
  }

  const storyButton = e.target.closest('.story-btn');
  if(storyButton) {
      const { index } = storyButton.dataset;
      showStory(index);
      return;
  }
});

function closeTrailerModal() {
  $trailerModal.style.display = 'none';
  $trailerFrame.src = '';
}
function closeStoryModal() {
    $storyModal.style.display = 'none';
}

$trailerCloseBtn.addEventListener('click', closeTrailerModal);
$storyCloseBtn.addEventListener('click', closeStoryModal);

window.addEventListener('click', (e) => {
  if (e.target == $trailerModal) {
    closeTrailerModal();
  }
  if (e.target == $storyModal) {
      closeStoryModal();
  }
});