/*
 * おもいでリール
 * 写真の読み込み・解析・スライドショー描画・動画化をすべてブラウザ内で行う。
 * 写真やタイトルを外部に送る処理は存在しない（通信は同一オリジンのBGM取得のみ）。
 */
(() => {
  'use strict';

  // ---------- 定数 ----------
  const LIMITS = Object.freeze({
    maxFiles: 60,                 // 枚数の上限
    maxBytes: 40 * 1024 * 1024,   // 1枚あたりのファイルサイズ上限
    maxSide: 2200,                // 取り込み時に縮小する長辺
    maxSourceSide: 16384,         // 元画像の一辺の上限（巨大画像によるメモリ枯渇を防ぐ）
    maxSourcePixels: 100e6
  });
  const TRACKS = Object.freeze({
    sunny: { file: 'audio/sunny-steps.mp3', name: 'Sunny Steps', mood: '明るく色あざやか', tint: '#f2a33a' },
    golden: { file: 'audio/golden-hour.mp3', name: 'Golden Hour', mood: 'あたたかい色合い', tint: '#d9764a' },
    breeze: { file: 'audio/blue-breeze.mp3', name: 'Blue Breeze', mood: 'すっきり爽やか', tint: '#4a93b8' },
    night: { file: 'audio/night-lights.mp3', name: 'Night Lights', mood: '夜・しっとり', tint: '#5a5a9c' }
  });
  const SIZES = Object.freeze({ landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] }); // フルHD
  // 端末の力が足りず動きがカクつくときに使う、ひとまわり小さいサイズ
  const SIZES_LIGHT = Object.freeze({ landscape: [1280, 720], portrait: [720, 1280], square: [960, 960] });
  const FONT = '"Hiragino Maru Gothic ProN","Hiragino Sans","Yu Gothic UI","Yu Gothic","Noto Sans JP","Meiryo",sans-serif';
  const FPS = 30;

  // ---------- 要素 ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), start: $('start'), loading: $('loading'), player: $('player'), file: $('file'),
    loadStatus: $('load-status'), loadBar: $('load-bar'), errBox: $('err-box'), errSum: $('err-sum'), errors: $('errors'), tip: $('tip'),
    view: $('view'), strip: $('strip'), stage: $('stage'), canvas: $('screen'), bigPlay: $('big-play'), rec: $('rec'), recBar: $('rec-bar'), recLeft: $('rec-left'), info: $('info'), recCancel: $('rec-cancel'),
    play: $('play'), seek: $('seek'), time: $('time'), playStatus: $('play-status'),
    send: $('send'), sendLabel: $('send-label'), sendSub: $('send-sub'),
    result: $('result'), resultTitle: $('result-title'), resultMedia: $('result-media'), resultNote: $('result-note'),
    share: $('share'), save: $('save'), resultClose: $('result-close'),
    adjust: $('adjust'), clear: $('clear'), panel: $('panel'), chips: Array.from(document.querySelectorAll('.chips[data-group] > .chip')),
    title: $('title'), count: $('count'), thumbs: $('thumbs'), sortTime: $('sort-time'), poster: $('poster')
  };
  // アレンジの選択（何も触らなければ全部おまかせ）
  const choice = { track: 'auto', aspect: 'auto', dur: 'auto', fit: 'fill', filter: 'none' };
  // ファイルつきの共有ができる端末（スマホ）なら「LINEに送る」、できない端末（PCなど）なら「動画を保存」
  const CAN_SHARE = !!(navigator.canShare && navigator.share);
  const ctx = el.canvas.getContext('2d', { alpha: false });

  // ---------- 状態 ----------
  const state = {
    photos: [],        // { id, blob, w, h, tiny, thumb, stats, time }
    nextId: 1,
    nextSeq: 1,
    loading: false,
    autoTrack: 'breeze',
    playing: false,
    pos: 0,            // 停止中の再生位置（秒）
    exporting: false,  // 「動画をつくっています」の待ち画面を出しているか
    muted: false,
    errorCount: 0,
    light: false,      // フルHDだとカクつく端末では true（自動で切りかわる）
    manualOrder: false, // 手で並べ替えたか（していなければ日時順に自動整列）
    ready: null,       // できあがった動画 { blob, name, note }（写真や設定を変えると無効になる）
    resultUrl: null,
    resultFile: null
  };

  // ---------- 小道具 ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ease = (p) => p * p * (3 - 2 * p);
  const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const toBlob = (canvas, type, q) => new Promise((res, rej) => {
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, q);
  });
  // 文字を入れる。同じ文なら何もしない（毎フレーム呼ばれても画面を書きかえない）
  function setText(node, text) {
    if (node.dataset && node.dataset.raw === text) return;
    node.textContent = text;
    if (node.dataset) node.dataset.raw = text;
  }
  const rawOf = (node) => (node.dataset && node.dataset.raw !== undefined ? node.dataset.raw : node.textContent);

  // ---------- ふりがな（小さい子向け。右上のボタンか、URLの ?kana=1 で入る） ----------
  // 画面に出す言葉はこの表の漢字だけで書く。長いことばを先に当てる
  const KANA = [
    ['思い出', 'おもいで'], ['色あい', 'いろあい'], ['白黒', 'しろくろ'], ['王冠', 'おうかん'], ['音符', 'おんぷ'], ['最高', 'さいこう'], ['場所', 'ばしょ'], ['同じ', 'おなじ'],
    ['動く', 'うごく'], ['動き', 'うごき'], ['付け', 'つけ'], ['付き', 'つき'], ['星', 'ほし'], ['花', 'はな'], ['夏', 'なつ'], ['色', 'いろ'], ['右下', 'みぎした'], ['左下', 'ひだりした'], ['左上', 'ひだりうえ'], ['右上', 'みぎうえ'],
    ['修学旅行', 'しゅうがくりょこう'], ['並べ替え', 'ならべかえ'], ['送り先', 'おくりさき'], ['場面', 'ばめん'], ['編集', 'へんしゅう'], ['見せ方', 'みせかた'], ['表紙', 'ひょうし'], ['余白', 'よはく'], ['右端', 'みぎはし'], ['仕上', 'しあ'], ['送れ', 'おくれ'], ['映', 'うつ'], ['他', 'た'], ['先', 'さき'], ['中', 'なか'], ['乗', 'の'], ['一覧', 'いちらん'], ['動か', 'うごか'], ['全体', 'ぜんたい'], ['合', 'あ'], ['読み込み中', 'よみこみちゅう'], ['正方形', 'せいほうけい'], ['文化祭', 'ぶんかさい'], ['体育祭', 'たいいくさい'],
    ['誕生日', 'たんじょうび'], ['準備中', 'じゅんびちゅう'], ['読み込', 'よみこ'], ['受け取', 'うけと'], ['何枚', 'なんまい'], ['写真', 'しゃしん'], ['動画', 'どうが'],
    ['送信', 'そうしん'], ['最初', 'さいしょ'], ['全部', 'ぜんぶ'], ['変更', 'へんこう'], ['画像', 'がぞう'], ['保存', 'ほぞん'], ['再生', 'さいせい'], ['追加', 'ついか'],
    ['理由', 'りゆう'], ['一度', 'いちど'], ['途中', 'とちゅう'], ['端末', 'たんまつ'], ['共有', 'きょうゆう'], ['部活', 'ぶかつ'], ['旅行', 'りょこう'], ['画面', 'がめん'],
    ['開け', 'あけ'], ['選', 'えら'], ['見', 'み'], ['送', 'おく'], ['枚', 'まい'], ['戻', 'もど'], ['消', 'け'], ['閉', 'と'], ['曲', 'きょく'], ['並', 'なら'], ['順', 'じゅん'],
    ['形', 'かたち'], ['速', 'はや'], ['夜', 'よる'], ['横', 'よこ'], ['縦', 'たて'], ['撮', 'と'], ['元', 'もと'], ['作', 'つく'], ['終', 'お'], ['始', 'はじ'], ['増', 'ふ'],
    ['使', 'つか'], ['押', 'お'], ['件', 'けん'], ['外', 'はず'], ['目', 'め'], ['音', 'おと'], ['出', 'で'], ['止', 'と'], ['続', 'つづ'], ['秒', 'びょう'], ['古', 'ふる'],
    ['開', 'ひら'], ['次', 'つぎ'], ['早', 'はや'], ['年', 'ねん'], ['月', 'がつ'], ['壊', 'こわ'], ['入', 'はい'], ['向', 'む'], ['短', 'みじか'], ['長', 'なが'], ['分', 'ふん'], ['用', 'よう'], ['減', 'へ'], ['例', 'れい'], ['組', 'くみ'], ['残', 'のこ'], ['変', 'か'], ['大', 'おお']
  ];
  const KANA_MAP = new Map(KANA);
  const KANA_RE = new RegExp(KANA.map((k) => k[0]).join('|'), 'g');
  const kana = { on: false, busy: false, observer: null };
  function annotate(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    if (root.nodeType === 3) nodes.push(root);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) nodes.push(t);
    for (const t of nodes) {
      const parent = t.parentElement;
      if (!parent || parent.closest('ruby, rt, script, style, noscript, textarea') || !KANA_RE.test(t.data)) { KANA_RE.lastIndex = 0; continue; }
      KANA_RE.lastIndex = 0;
      const parts = [];
      let last = 0;
      t.data.replace(KANA_RE, (word, at) => {
        if (at > last) parts.push(t.data.slice(last, at));
        const ruby = document.createElement('ruby'), rt = document.createElement('rt');
        rt.textContent = KANA_MAP.get(word);
        ruby.append(word, rt);
        parts.push(ruby);
        last = at + word.length;
        return word;
      });
      if (last < t.data.length) parts.push(t.data.slice(last));
      t.replaceWith(...parts);
    }
  }
  function setKana(on) {
    kana.on = !!on;
    document.body.classList.toggle('kana-on', kana.on);
    const btn = document.getElementById('kana');
    if (btn) btn.setAttribute('aria-pressed', String(kana.on));
    if (kana.on) {
      if (!kana.observer) {
        kana.observer = new MutationObserver((records) => {
          if (!kana.on || kana.busy) return;
          kana.busy = true;
          for (const r of records) {
            if (r.type === 'characterData') annotate(r.target);
            else for (const n of r.addedNodes) if (n.isConnected && (n.nodeType === 1 || n.nodeType === 3)) annotate(n);
          }
          kana.observer.takeRecords();
          kana.busy = false;
        });
      }
      kana.busy = true;
      annotate(document.body);
      kana.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      kana.observer.takeRecords();
      kana.busy = false;
    } else {
      if (kana.observer) kana.observer.disconnect();
      for (const r of Array.from(document.querySelectorAll('ruby'))) { const rt = r.querySelector('rt'); if (rt) rt.remove(); r.replaceWith(r.textContent); }
      document.body.normalize();
    }
    // この表示のまま人に渡せるよう、URLにも残す（保存はしない）
    try { history.replaceState(history.state, '', kana.on ? '?kana=1' : location.pathname); } catch (_) {}
  }
  const cleanText = (s) => String(s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 40);
  const shortName = (name) => { const n = cleanText(name); return n.length > 28 ? n.slice(0, 25) + '…' : n; };

  // おまかせのかたち：たて向きの写真が多ければ、たて長にする
  function autoShape() {
    const n = state.photos.length;
    const tall = state.photos.filter((p) => p.h > p.w * 1.1).length;
    return n && tall / n > 0.6 ? 'portrait' : 'landscape';
  }
  // 下のお知らせ欄。読み終わるころ（7秒）に自動で消して、古い情報を残さない
  let hintTimer = 0;
  function hint(msg) {
    setText(el.playStatus, msg);
    clearTimeout(hintTimer);
    if (msg && !msg.includes('▶')) hintTimer = setTimeout(() => { if (rawOf(el.playStatus) === msg) setText(el.playStatus, ''); }, 7000);
  }
  function settings() {
    const n = state.photos.length;
    const shape = Object.hasOwn(SIZES, choice.aspect) ? choice.aspect : autoShape();
    const d = Number(choice.dur);
    // おまかせ：枚数が多いほど1枚を短くして、全体をおよそ50秒以内におさめる
    const dur = d === 2.5 || d === 3.5 || d === 5 ? d : Math.round(clamp(50 / Math.max(1, n), 2, 3.5) * 10) / 10;
    const pick = choice.track;
    const track = pick === 'none' ? null : (Object.hasOwn(TRACKS, pick) ? pick : state.autoTrack);
    return { size: (state.light ? SIZES_LIGHT : SIZES)[shape], dur, track, title: cleanText(el.title.value), subtitle: '' };
  }
  const totalTime = () => Math.max(1, state.photos.length) * settings().dur;
  const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);

  // ---------- 写真の取り込み ----------
  // 拡張子やMIME申告は信用せず、先頭バイトで画像形式を確認する
  async function sniff(file) {
    const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b[0] === 0x89 && str(1, 3) === 'PNG') return 'png';
    if (str(0, 4) === 'GIF8') return 'gif';
    if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return 'webp';
    if (str(4, 4) === 'ftyp' && ['avif', 'avis', 'heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(str(8, 4))) return 'isobmff';
    if (str(4, 4) === 'ftyp' || (file.type || '').startsWith('video/')) return 'video';
    return null;
  }

  // デコード前にヘッダーから縦横サイズを読む（巨大画像を展開してメモリを使い切るのを防ぐ）
  async function headerSize(file, kind) {
    const b = new Uint8Array(await file.slice(0, kind === 'jpeg' ? 1048576 : 32).arrayBuffer());
    const be16 = (o) => (b[o] << 8) | b[o + 1];
    if (kind === 'png' && b.length >= 24) return [be16(16) * 65536 + be16(18), be16(20) * 65536 + be16(22)];
    if (kind === 'gif' && b.length >= 10) return [b[6] | (b[7] << 8), b[8] | (b[9] << 8)];
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [be16(i + 7), be16(i + 5)];
        i += 2 + be16(i + 2);
      }
    }
    return null;
  }
  const tooBig = (w, h) => !w || !h || w > LIMITS.maxSourceSide || h > LIMITS.maxSourceSide || w * h > LIMITS.maxSourcePixels;

  async function decode(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      return await createImageBitmap(file);
    }
  }

  function measure(tiny) {
    // 明るさ・鮮やかさ・暖かさ（赤み−青み）の平均
    const d = tiny.getContext('2d').getImageData(0, 0, tiny.width, tiny.height).data;
    let L = 0, S = 0, W = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      L += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      S += mx === 0 ? 0 : (mx - mn) / mx;
      W += r - b;
    }
    return { L: L / n, S: S / n, W: W / n };
  }

  async function importOne(file) {
    if (!(file instanceof Blob)) throw new Error('ファイルではありません');
    if (file.size === 0) throw new Error('空のファイルです');
    if (file.size > LIMITS.maxBytes) throw new Error('大きすぎる写真です（40MBまで）');
    const kind = await sniff(file);
    if (kind === 'video') throw new Error('動画は使えません。写真を選んでください');
    if (!kind) throw new Error('写真ではないファイルです');
    const dim = await headerSize(file, kind);
    if (dim && tooBig(dim[0], dim[1])) throw new Error('画像サイズが大きすぎます');
    let bmp;
    try { bmp = await decode(file); } catch (_) {
      throw new Error(kind === 'isobmff' ? 'この写真の形式（HEIC）は、このブラウザでは開けません' : '壊れているか、開けない写真です');
    }
    try {
      const sw = bmp.width, sh = bmp.height;
      if (tooBig(sw, sh)) throw new Error('画像サイズが大きすぎます');
      const k = Math.min(1, LIMITS.maxSide / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
      const full = makeCanvas(w, h);
      const fc = full.getContext('2d', { alpha: false });
      fc.fillStyle = '#fff'; fc.fillRect(0, 0, w, h);
      fc.imageSmoothingQuality = 'high';
      fc.drawImage(bmp, 0, 0, w, h);
      // 再エンコードすることで、位置情報などのExifは引き継がれない
      const blob = await toBlob(full, 'image/jpeg', 0.9);

      const tk = 40 / Math.max(w, h);
      const tiny = makeCanvas(Math.max(1, Math.round(w * tk)), Math.max(1, Math.round(h * tk)));
      tiny.getContext('2d', { willReadFrequently: true }).drawImage(full, 0, 0, tiny.width, tiny.height);

      // 背景用：同じ写真の色をおさえて暗くしたもの（写真そのものより目立たせない）
      // いったんごく小さくしてから戻すことで、四角いムラのない、なめらかなぼけにする
      const mid = makeCanvas(Math.max(2, Math.round(tiny.width / 4)), Math.max(2, Math.round(tiny.height / 4)));
      const mc = mid.getContext('2d');
      mc.imageSmoothingQuality = 'high';
      mc.drawImage(tiny, 0, 0, mid.width, mid.height);
      const bg = makeCanvas(tiny.width * 2, tiny.height * 2);
      const bc = bg.getContext('2d');
      bc.imageSmoothingQuality = 'high';
      bc.drawImage(mid, 0, 0, bg.width, bg.height);
      bc.globalCompositeOperation = 'saturation'; // 彩度を落とす（対応していないブラウザでは次の暗い膜だけがかかる）
      bc.globalAlpha = 0.7; bc.fillStyle = '#808080'; bc.fillRect(0, 0, bg.width, bg.height);
      bc.globalCompositeOperation = 'source-over';
      bc.globalAlpha = 0.62; bc.fillStyle = '#14151a'; bc.fillRect(0, 0, bg.width, bg.height);
      bc.globalAlpha = 1;

      const thumb = makeCanvas(208, 208);
      drawCover(thumb.getContext('2d'), full, w, h, 0, 0, 208, 208);
      full.width = full.height = 0;

      return { id: state.nextId++, blob, w, h, tiny, bg, thumb, stats: measure(tiny), time: Number(file.lastModified) || 0 };
    } finally {
      bmp.close();
    }
  }

  async function addFiles(list) {
    if (state.loading || state.exporting) return;
    const files = Array.from(list || []);
    if (!files.length) return;
    state.loading = true;
    if (!/LINE|ブラウザ/.test(rawOf(el.tip))) el.tip.hidden = true;
    clearUndo();
    stop();
    updateButtons();
    clearErrors();
    const room = Math.max(0, LIMITS.maxFiles - state.photos.length);
    // 上限をこえるときは、最初から順にではなく、全体からまんべんなく選ぶ（行事の最後まで入るように）。
    // 読み込めない写真があったら、残りの写真で穴をうめる
    const over = files.length > room ? files.length : 0;
    const first = over ? Array.from({ length: room }, (_, k) => Math.round((k * (files.length - 1)) / Math.max(1, room - 1))) : files.map((_, k) => k);
    const chosen = new Set(first);
    const queue = first.concat(files.map((_, k) => k).filter((k) => !chosen.has(k)));
    const goal = Math.min(room, files.length);
    let done = 0, added = 0, dup = 0, next = 0, pending = 0, prefetched = false;
    const before = state.photos.length;
    const have = new Set(state.photos.map((ph) => ph.key));
    const results = new Array(files.length);
    state.cancelLoad = false;
    $('load-strip').replaceChildren();
    setText(el.loadStatus, `写真を読み込み中　0 / ${goal}枚`);
    el.loadBar.value = 0;
    // 3枚ずつ同時に読み込む（順番は選んだとおりに保つ）
    const worker = async () => {
      for (;;) {
        if (next >= queue.length || state.cancelLoad || added + pending >= room) return;
        const i = queue[next++];
        const f = files[i];
        // 同じ写真（名前・サイズ・日時が同じ）は二重に入れない
        const key = `${f.name}|${f.size}|${f.lastModified}`;
        if (have.has(key)) dup++;
        else {
          have.add(key);
          pending++;
          try {
            const photo = await importOne(f);
            photo.key = key;
            results[i] = photo;
            added++;
            if ($('load-strip').childElementCount < 18) $('load-strip').append(miniOf(photo, 88));
            // 読み込みながら雰囲気を見て、合いそうな曲を先に取りに行く（再生開始を早くする）
            if (added === 3 && !prefetched) {
              prefetched = true;
              const k = choice.track === 'auto' ? pickMood(results.filter(Boolean)) : choice.track;
              if (Object.hasOwn(TRACKS, k)) fetchRaw(k);
            }
          } catch (e) {
            addError(`${shortName(f.name || '写真')}：${e && e.message ? e.message : '読み込めませんでした'}`);
          }
          pending--;
        }
        done++;
        setText(el.loadStatus, `写真を読み込み中　${Math.min(done, goal)} / ${goal}枚`);
        el.loadBar.value = Math.min(1, done / goal);
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const photo of results) if (photo) { photo.seq = state.nextSeq++; state.photos.push(photo); }
    setText(el.loadStatus, '');
    state.loading = false;
    el.file.value = '';
    // 手で並べ替えていなければ、撮影（保存）日時の順にそろえる
    if (!state.manualOrder) sortByTime();
    photosChanged();
    // 何が起きたかをひとことで
    const n = state.photos.length;
    if (!before && n) { try { history.pushState({ omoide: 1 }, '', location.href); } catch (_) {} }
    let msg = '';
    if (over && added) msg = `${over}枚の中から、${added}枚を選んで使いました（${LIMITS.maxFiles}枚まで）`;
    else if (!room) msg = `${LIMITS.maxFiles}枚でいっぱいです`;
    else if (before && added) msg = `${added}枚追加しました（全部で${n}枚）`;
    else if (before && !added && dup) msg = 'その写真はもう入っています';
    else if (n === 1) msg = '写真が1枚だけです。「写真を追加」で増やせます';

    // 1分をこえたら、短くする方法を一度だけ伝える
    if (added && totalTime() > 60 && !state.saidLong && !over) { state.saidLong = true; msg = `${fmt(totalTime())}の動画です。短くするなら、編集の「形・速さ」で「さくさく」に`; }
    hint(msg);
    // えらんだらすぐ再生。同時に録画して、見終わるころには動画ができている
    if (added && n) autoStart();
  }
  // 写真の小さいコピー（読み込み中の表示・写真の帯で使う）
  function miniOf(photo, px) {
    const m = makeCanvas(px, px);
    m.getContext('2d').drawImage(photo.thumb, 0, 0, px, px);
    return m;
  }
  const sortByTime = () => state.photos.sort((a, b) => a.time - b.time || a.seq - b.seq);

  function addError(msg) {
    const li = document.createElement('li');
    setText(li, msg);
    if (el.errors.childElementCount < 8) el.errors.append(li);
    state.errorCount++;
    setText(el.errSum, `使えなかった写真：${state.errorCount}件（押すと理由）`);
    el.errBox.hidden = false;
  }
  function clearErrors() {
    state.errorCount = 0;
    el.errors.replaceChildren();
    el.errBox.hidden = true; el.errBox.open = false;
  }

  // ---------- サムネイル一覧（調整パネルの中） ----------
  function renderThumbs() {
    const n = state.photos.length;
    for (const p of state.photos) syncThumb(p);
    setText(el.count, `${n}枚`);
    const items = state.photos.map((p, i) => {
      const li = document.createElement('li');
      p.thumb.setAttribute('role', 'img');
      p.thumb.setAttribute('aria-label', `${i + 1}枚目の写真`);
      const row = document.createElement('div');
      row.className = 'thumb-btns';
      const mk = (label, text, fn, disabled) => {
        const b = document.createElement('button');
        b.type = 'button'; b.disabled = !!disabled || state.exporting;
        b.setAttribute('aria-label', `${i + 1}枚目を${label}`);
        setText(b, text);
        b.addEventListener('click', fn);
        return b;
      };
      row.append(
        mk('前へ', '◀', () => move(i, -1), i === 0),
        mk('後ろへ', '▶', () => move(i, 1), i === n - 1)
      );
      const rm = mk('はずす', '✕', () => remove(i));
      rm.className = 'rm';
      const num = document.createElement('span');
      num.className = 'num';
      setText(num, String(i + 1));
      const pic = document.createElement('button');
      pic.type = 'button'; pic.className = 'pic';
      pic.setAttribute('aria-label', `${i + 1}枚目の場面を見る`);
      pic.append(p.thumb, num);
      pic.addEventListener('click', () => jumpTo(i));
      const wrap = document.createElement('div');
      wrap.className = 'pic-wrap';
      wrap.append(pic, rm);
      // 1枚目は「表紙」。ほかの写真は1回押すだけで表紙にできる
      const cover = document.createElement('button');
      cover.type = 'button'; cover.className = i === 0 ? 'cover now' : 'cover';
      cover.disabled = i === 0 || state.exporting;
      setText(cover, i === 0 ? '★ 表紙' : '表紙にする');
      cover.setAttribute('aria-label', i === 0 ? '1枚目の写真（いまの表紙）' : `${i + 1}枚目を表紙にする（1枚目へ移動）`);
      cover.addEventListener('click', () => makeCover(i));
      li.append(wrap, row, cover);
      return li;
    });
    el.thumbs.replaceChildren(...items);
    // 17 一覧の最後から写真を追加できる
    if (n < LIMITS.maxFiles) {
      const tile = document.createElement('li');
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'add-tile';
      setText(add, '＋ 写真を追加');
      add.addEventListener('click', () => { if (!el.file.disabled) el.file.click(); });
      tile.append(add);
      el.thumbs.append(tile);
    }
    // 21 動画の下の写真の帯
    el.strip.replaceChildren(...state.photos.map((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `${i + 1}枚目の場面を見る`);
      b.append(miniOf(p, 112));
      b.addEventListener('click', () => jumpTo(i));
      return b;
    }));
    nowIndex = -1;
    // 再生バーに写真の区切りを入れる（多すぎるときは省く）
    $('ticks').replaceChildren(...(n > 1 && n <= 40 ? Array.from({ length: n - 1 }, (_, k) => {
      const tick = document.createElement('i');
      tick.style.left = `${((k + 1) / n) * 100}%`;
      return tick;
    }) : []));
    el.sortTime.hidden = !state.manualOrder; // 17 並べ替えたときだけ出す
  }
  // 写真を押したら、その写真の場面で止めて見せる
  function jumpTo(i) {
    if (state.exporting || !state.photos[i]) return;
    stop();
    hint('');
    state.pos = i * settings().dur + 0.02;
    refresh();
  }
  // いま映っている写真に印をつける
  let nowIndex = -1;
  function markNow(i) {
    if (i === nowIndex) return;
    const items = el.thumbs.children;
    if (items[nowIndex]) items[nowIndex].classList.remove('now');
    if (items[i]) items[i].classList.add('now');
    const bar = el.strip.children;
    if (bar[nowIndex]) bar[nowIndex].classList.remove('now');
    if (bar[i]) {
      bar[i].classList.add('now');
      // いまの写真が帯の中に見えるように寄せる
      const x = bar[i].offsetLeft - el.strip.offsetLeft, w = el.strip.clientWidth;
      if (x < el.strip.scrollLeft + 40 || x > el.strip.scrollLeft + w - 100) el.strip.scrollLeft = Math.max(0, x - w / 2 + 28);
    }
    nowIndex = i;
    if (!el.panel.hidden && el.panel.dataset.tab === 'deco') syncDeco();
  }

  function makeCover(i) {
    if (state.exporting || i <= 0 || !state.photos[i]) return;
    const [p] = state.photos.splice(i, 1);
    state.photos.unshift(p);
    state.manualOrder = true;
    photosChanged();
    jumpTo(0);
    hint('表紙を変えました');
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= state.photos.length || state.exporting) return;
    const a = state.photos;
    [a[i], a[j]] = [a[j], a[i]];
    state.manualOrder = true;
    photosChanged();
  }
  function remove(i) {
    if (state.exporting) return;
    const [p] = state.photos.splice(i, 1);
    if (p) dropCache(p.id);
    if (!state.photos.length) state.manualOrder = false;
    photosChanged();
    if (p && state.photos.length) offerUndo(p, i);
    else if (p) { setText(el.tip, '写真が0枚になりました。もう一度選んでください'); el.tip.hidden = false; }
  }
  $('drop-now').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.exporting || state.photos.length < 2) return;
    const i = currentIndex();
    remove(i);
    jumpTo(Math.min(i, state.photos.length - 1)); // 最初に戻さず、同じ場所の次の写真を見せる
  });
  // 外した写真は、しばらくの間「元にもどす」で戻せる
  let undo = null;
  function offerUndo(photo, index) {
    clearUndo();
    undo = { photo, index, timer: setTimeout(clearUndo, 12000) };
    setText($('undo-text'), `${index + 1}枚目を外しました`);
    $('undo').hidden = false;
  }
  function clearUndo() {
    if (undo) clearTimeout(undo.timer);
    undo = null;
    $('undo').hidden = true;
  }
  function doUndo() {
    if (!undo || state.exporting || state.loading) return;
    const { photo, index } = undo;
    clearUndo();
    state.photos.splice(Math.min(index, state.photos.length), 0, photo);
    photosChanged();
    jumpTo(Math.min(index, state.photos.length - 1));
  }
  // 写真や設定が変わったら、作成済みの動画は使えなくなる
  function invalidate() {
    state.ready = null; state.sent = false;
    closeResult();
    updateSend(0, totalTime());
  }
  function photosChanged() {
    stop();
    invalidate();
    state.pos = 0;
    renderThumbs();
    renderIdeas();
    analyzeMood();
    refresh();
  }

  // ---------- 雰囲気の判定 → BGM ----------
  function analyzeMood() {
    if (!state.photos.length) { renderChips(); return; }
    state.autoTrack = pickMood(state.photos);
    showMood();
  }
  function pickMood(photos) {
    const n = photos.length;
    let L = 0, S = 0, W = 0;
    for (const p of photos) { L += p.stats.L; S += p.stats.S; W += p.stats.W; }
    L /= n; S /= n; W /= n;
    const score = {
      night: (0.34 - L) * 4,
      sunny: (S - 0.3) * 3 + (L - 0.5) * 1.5,
      golden: W * 4 - Math.max(0, S - 0.5) * 4 + (0.3 - Math.abs(L - 0.5)) * 0.4,
      breeze: -W * 3 + (0.28 - S) * 1.4 + 0.12
    };
    return Object.keys(score).reduce((a, b) => (score[b] > score[a] ? b : a));
  }
  function showMood() { renderChips(); }
  function renderChips() {
    for (const c of el.chips) {
      const group = c.parentElement.dataset.group, v = c.dataset.value;
      let on = choice[group] === v;
      // おまかせで選ばれたものに「おすすめ」印をつける
      const best = group === 'track' ? state.autoTrack : group === 'aspect' ? autoShape() : null;
      if (best) {
        if (choice[group] === 'auto') on = v === best;
        c.toggleAttribute('data-auto', v === best && state.photos.length > 0);
      }
      c.setAttribute('aria-pressed', String(on));
      c.disabled = state.exporting || state.loading;
    }
  }

  // ---------- 色あい（フィルター） ----------
  // iPhoneのSafariは canvas の filter に対応していないため、写真の色そのものを変換表で塗り替える。
  // 塗り替えは写真ごとに1回だけ（前後数枚ぶん）。再生中の負担はふえない
  const LOOKS = Object.freeze({
    none: null,
    soft: { name: 'ふんわり', sat: 0.88, contrast: 0.9, gamma: 0.9, bal: [1.03, 1, 0.95], lift: 0.035, fx: { leak: 0.16, vig: 0.12 } },
    film: { name: 'フィルム', sat: 0.76, s: 0.4, lift: 0.075, top: 0.93, bal: [1.02, 1, 0.96], add: [0, 0.006, 0.022], fx: { grain: 0.09, vig: 0.3 } },
    memory: { name: '思い出', sat: 0.85, sepia: 0.72, contrast: 0.94, gamma: 0.96, lift: 0.04, top: 0.97, fx: { vig: 0.45 } },
    mono: { name: '白黒', sat: 0, s: 0.32, contrast: 1.06, lift: 0.02, fx: { vig: 0.28 } },
    summer: { name: '夏', sat: 1.2, contrast: 1.06, gamma: 0.95, bal: [0.97, 1.02, 1.06] }
  });
  const builtLooks = new Map();
  function lookOf(key) {
    const def = LOOKS[key];
    if (!def) return null;
    let f = builtLooks.get(key);
    if (f) return f;
    const [lr, lg, lb] = [0.2126, 0.7152, 0.0722];
    const s = def.sat === undefined ? 1 : def.sat;
    // 彩度 → セピアの順にかける 3×3 の行列
    const S = [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s), lr * (1 - s), lg * (1 - s) + s, lb * (1 - s), lr * (1 - s), lg * (1 - s), lb * (1 - s) + s];
    const a = def.sepia || 0;
    const SEP = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
    const P = SEP.map((v, k) => (1 - a) * (k % 4 === 0 ? 1 : 0) + a * v);
    const m = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = P[r * 3] * S[c] + P[r * 3 + 1] * S[3 + c] + P[r * 3 + 2] * S[6 + c];
    // 明るさのカーブ（色ごと）
    const lut = [0, 1, 2].map((ch) => {
      const t = new Uint8ClampedArray(256);
      for (let x = 0; x < 256; x++) {
        let y = Math.pow(x / 255, def.gamma || 1);
        y = 0.5 + (y - 0.5) * (def.contrast || 1);
        if (def.s) y = y * (1 - def.s) + ease(clamp(y, 0, 1)) * def.s;
        y = y * (def.bal ? def.bal[ch] : 1) + (def.add ? def.add[ch] : 0);
        const lo = def.lift || 0, hi = def.top || 1;
        t[x] = Math.round(clamp(lo + y * (hi - lo), 0, 1) * 255);
      }
      return t;
    });
    f = { key, m, lut, fx: def.fx || null };
    builtLooks.set(key, f);
    return f;
  }
  function tintPixels(d, f) {
    const m = f.m, r0 = f.lut[0], g0 = f.lut[1], b0 = f.lut[2];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const R = m[0] * r + m[1] * g + m[2] * b, G = m[3] * r + m[4] * g + m[5] * b, B = m[6] * r + m[7] * g + m[8] * b;
      d[i] = r0[R < 0 ? 0 : R > 255 ? 255 : R | 0];
      d[i + 1] = g0[G < 0 ? 0 : G > 255 ? 255 : G | 0];
      d[i + 2] = b0[B < 0 ? 0 : B > 255 ? 255 : B | 0];
    }
  }
  // 小さい画像はその場で塗り替える
  function tintCanvas(src, w, h, f) {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    if (f) { const img = g.getImageData(0, 0, w, h); tintPixels(img.data, f); g.putImageData(img, 0, 0); }
    return c;
  }
  // 大きい写真は帯に分けて少しずつ塗り替える（再生中の動きを止めない）
  async function tintLarge(bmp, f, alive) {
    const w = bmp.width, h = bmp.height;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const rows = Math.max(16, Math.floor(260000 / w));
    for (let y = 0; y < h; y += rows) {
      if (!alive()) { c.width = c.height = 0; return null; }
      const hh = Math.min(rows, h - y);
      const img = g.getImageData(0, y, w, hh);
      tintPixels(img.data, f);
      g.putImageData(img, 0, y);
      await new Promise((r) => setTimeout(r, 0));
    }
    const out = await createImageBitmap(c);
    c.width = c.height = 0;
    return out;
  }
  // 写真ごとの小さい版（読み込み待ちの代わり・ぼかし背景）は色あいごとに作っておく
  function smallOf(photo) {
    const key = choice.filter;
    if (!LOOKS[key]) return { tiny: photo.tiny, bg: photo.bg };
    if (!photo.looks) photo.looks = {};
    let v = photo.looks[key];
    if (!v) {
      const f = lookOf(key);
      v = photo.looks[key] = {
        tiny: tintCanvas(photo.tiny, photo.tiny.width, photo.tiny.height, f),
        bg: photo.bg ? tintCanvas(photo.bg, photo.bg.width, photo.bg.height, f) : null
      };
    }
    return v;
  }
  // 一覧の小さい写真も同じ色あいにそろえる
  function syncThumb(photo) {
    if (photo.thumbKey === choice.filter) return;
    if (!photo.thumb0) photo.thumb0 = tintCanvas(photo.thumb, photo.thumb.width, photo.thumb.height, null);
    const g = photo.thumb.getContext('2d');
    const f = lookOf(choice.filter);
    g.drawImage(f ? tintCanvas(photo.thumb0, photo.thumb0.width, photo.thumb0.height, f) : photo.thumb0, 0, 0);
    photo.thumbKey = choice.filter;
  }

  // 色あいに付く「重ねる効果」（周辺を暗く・やわらかい光・フィルムの粒）。どれも毎コマ描いても軽い
  const overlay = { vig: null, grain: null, grainPat: null };
  function vignette() {
    if (overlay.vig) return overlay.vig;
    const c = makeCanvas(128, 128), g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 30, 64, 64, 92);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return (overlay.vig = c);
  }
  function grainPattern() {
    if (overlay.grainPat) return overlay.grainPat;
    const c = makeCanvas(160, 160), g = c.getContext('2d');
    const img = g.createImageData(160, 160), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = hash01(i * 7 + 3) < 0.5 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.round(hash01(i + 11) * 255);
    }
    g.putImageData(img, 0, 0);
    overlay.grain = c;
    return (overlay.grainPat = ctx.createPattern(c, 'repeat'));
  }
  function drawLook(t, W, H) {
    const f = lookOf(choice.filter);
    if (!f || !f.fx) return;
    const fx = f.fx;
    ctx.save();
    if (fx.leak) {
      // 左上からさしこむ、あたたかい光。ごくゆっくり動く
      const x = W * (0.12 + 0.06 * Math.sin(t * 0.35)), y = H * (0.08 + 0.05 * Math.cos(t * 0.27)), r = Math.max(W, H) * 0.7;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,214,170,${fx.leak})`); gr.addColorStop(1, 'rgba(255,214,170,0)');
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (fx.vig) { ctx.globalAlpha = fx.vig; ctx.drawImage(vignette(), -W * 0.04, -H * 0.04, W * 1.08, H * 1.08); }
    if (fx.grain) {
      const pat = grainPattern();
      const k = Math.max(1.5, Math.min(W, H) / 700), shift = (Math.floor(t * 12) * 53) % 160;
      ctx.globalAlpha = fx.grain;
      ctx.setTransform(k, 0, 0, k, -shift * k, -((shift * 3) % 160) * k);
      ctx.fillStyle = pat; ctx.fillRect(0, 0, W / k + 320, H / k + 320);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
  }

  // ---------- かざり（スタンプ・動くかざり・ひとこと） ----------
  // 絵はすべてこのファイルの中で線と色から描く（外から画像を読みこまない・どの端末でも同じ見た目）
  const STAMPS = [
    { k: 'heart', name: 'ハート' }, { k: 'smile', name: 'にこにこ' }, { k: 'laugh', name: '大わらい' }, { k: 'wow', name: 'びっくり' },
    { k: 'star', name: '星' }, { k: 'kira', name: 'キラキラ' }, { k: 'flower', name: '花' }, { k: 'crown', name: '王冠' },
    { k: 'note', name: '音符' }, { k: 'best', name: '最高！', text: '最高！', color: '#e2546c' },
    { k: 'thanks', name: 'ありがとう', text: 'ありがとう', color: '#3f7fd0' }, { k: 'yay', name: 'おめでとう', text: 'おめでとう', color: '#e58a1f' }
  ];
  const STAMP = Object.fromEntries(STAMPS.map((s) => [s.k, s]));
  for (const s of STAMPS) if (s.text) { s.w = 34 + 34 * s.text.length; s.h = 58; }
  const POS = ['bl', 'br', 'tr', 'tl']; // 最初は左下（右下は画面の音ボタンと重なるため）
  const POS_NAME = { br: '右下', bl: '左下', tl: '左上', tr: '右上' };
  const MOVES = [{ k: 'none', name: 'なし' }, { k: 'hearts', name: 'ハート' }, { k: 'kira', name: 'キラキラ' }, { k: 'petals', name: '花びら' }];
  // 毎回同じ値になる乱数（再生と録画で動きがずれないように）
  function hash01(a) {
    let t = (a * 2654435761) >>> 0;
    t ^= t >>> 15; t = Math.imul(t, 2246822519) >>> 0;
    t ^= t >>> 13; t = Math.imul(t, 3266489917) >>> 0;
    t ^= t >>> 16;
    return (t >>> 0) / 4294967296;
  }
  const backOut = (u) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };
  const decoOf = (p) => p.deco || (p.deco = { stamp: null, pos: 'bl', move: 'none', say: '' });
  const hasDeco = (p) => !!(p.deco && (p.deco.stamp || p.deco.move !== 'none' || p.deco.say));

  // 白いふちどり＋うすい影（シール風）。u は 1単位あたりのピクセル数
  function rim(g, path, u, w) {
    g.save();
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = '#fff'; g.lineWidth = w || 11;
    g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 7 * u; g.shadowOffsetY = 2.5 * u;
    g.stroke(path);
    g.restore();
  }
  const ell = (p, x, y, rx, ry, rot) => { p.moveTo(x + rx * Math.cos(rot || 0), y + rx * Math.sin(rot || 0)); p.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); };
  function starPath(p, cx, cy, R, r, n, rot) {
    for (let k = 0; k < n * 2; k++) {
      const a = (rot || -Math.PI / 2) + (k * Math.PI) / n, rr = k % 2 ? r : R;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (k) p.lineTo(x, y); else p.moveTo(x, y);
    }
    p.closePath();
  }
  function face(g, u) {
    const p = new Path2D(); ell(p, 50, 50, 41, 41);
    rim(g, p, u); g.fillStyle = '#ffcd3c'; g.fill(p);
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(36, 26, 11, 6, -0.5, 0, Math.PI * 2); g.fill();
  }
  // 1つのスタンプを 100×100（文字のスタンプは横長）の単位で描く
  function paintStamp(g, k, u) {
    const dark = '#4a3426';
    g.lineCap = 'round'; g.lineJoin = 'round';
    switch (k) {
      case 'heart': {
        const p = new Path2D('M50 88C24 70 7 53 9 33 11 15 31 7 43 16 46 19 48 22 50 26 52 22 54 19 57 16 69 7 89 15 91 33 93 53 76 70 50 88Z');
        rim(g, p, u); g.fillStyle = '#ef5a74'; g.fill(p);
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.ellipse(27, 30, 8, 4.5, -0.7, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'smile': {
        face(g, u);
        g.fillStyle = dark; g.beginPath(); g.ellipse(37, 43, 4.5, 7, 0, 0, Math.PI * 2); g.ellipse(63, 43, 4.5, 7, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = dark; g.lineWidth = 5.5; g.beginPath(); g.arc(50, 52, 19, 0.18 * Math.PI, 0.82 * Math.PI); g.stroke();
        g.fillStyle = 'rgba(240,100,100,0.45)'; g.beginPath(); g.arc(26, 60, 6.5, 0, Math.PI * 2); g.arc(74, 60, 6.5, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'laugh': {
        face(g, u);
        g.strokeStyle = dark; g.lineWidth = 5.5;
        g.beginPath(); g.moveTo(29, 45); g.quadraticCurveTo(36, 34, 43, 45); g.moveTo(57, 45); g.quadraticCurveTo(64, 34, 71, 45); g.stroke();
        const m = new Path2D('M28 55H72C70 74 61 82 50 82 39 82 30 74 28 55Z');
        g.fillStyle = '#7a2e2e'; g.fill(m);
        g.save(); g.clip(m); g.fillStyle = '#ef6f6f'; g.beginPath(); g.ellipse(50, 80, 13, 8, 0, 0, Math.PI * 2); g.fill(); g.restore();
        g.fillStyle = '#fff'; g.fillRect(33, 55, 34, 5);
        const tear = new Path2D('M14 46C10 54 9 58 13 61 17 64 21 60 20 56 19 53 16 50 14 46ZM86 46C90 54 91 58 87 61 83 64 79 60 80 56 81 53 84 50 86 46Z');
        g.fillStyle = '#7cc6f2'; g.fill(tear);
        break;
      }
      case 'wow': {
        face(g, u);
        g.fillStyle = dark; g.beginPath(); g.arc(37, 44, 6, 0, Math.PI * 2); g.arc(63, 44, 6, 0, Math.PI * 2); g.fill();
        g.strokeStyle = dark; g.lineWidth = 4.5; g.beginPath(); g.arc(37, 36, 10, 1.2 * Math.PI, 1.8 * Math.PI); g.moveTo(55, 30); g.arc(63, 36, 10, 1.2 * Math.PI, 1.8 * Math.PI); g.stroke();
        g.fillStyle = '#7a2e2e'; g.beginPath(); g.ellipse(50, 67, 8, 10.5, 0, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'star': {
        const p = new Path2D(); starPath(p, 50, 54, 46, 20, 5);
        rim(g, p, u, 12); g.fillStyle = '#ffc928'; g.fill(p);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.ellipse(40, 40, 7, 4, -0.6, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'kira': {
        const p = new Path2D();
        starPath(p, 40, 58, 38, 9, 4); starPath(p, 77, 24, 19, 5, 4); starPath(p, 80, 77, 13, 3.5, 4);
        rim(g, p, u, 10); g.fillStyle = '#ffd34a'; g.fill(p);
        g.fillStyle = '#fff8d8'; g.beginPath(); g.arc(40, 58, 6, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'flower': {
        const p = new Path2D();
        for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5; ell(p, 50 + Math.cos(a) * 24, 50 + Math.sin(a) * 24, 19, 19); }
        rim(g, p, u); g.fillStyle = '#f59fbc'; g.fill(p);
        g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(50, 50, 14, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(45, 45, 4, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'crown': {
        const p = new Path2D('M14 78L18 30 36 50 50 20 64 50 82 30 86 78Z');
        ell(p, 18, 27, 6, 6); ell(p, 50, 17, 6.5, 6.5); ell(p, 82, 27, 6, 6);
        rim(g, p, u); g.fillStyle = '#f8c73a'; g.fill(p);
        g.fillStyle = '#e8a91c'; g.fillRect(14, 68, 72, 10);
        g.fillStyle = '#e9546b'; g.beginPath(); g.arc(50, 56, 6.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#4a90d9'; g.beginPath(); g.arc(31, 60, 4.5, 0, Math.PI * 2); g.arc(69, 60, 4.5, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'note': {
        const p = new Path2D();
        ell(p, 30, 76, 14, 10, -0.4); ell(p, 70, 68, 14, 10, -0.4);
        p.rect(39, 22, 6, 54); p.rect(79, 14, 6, 54);
        p.moveTo(39, 22); p.lineTo(85, 12); p.lineTo(85, 26); p.lineTo(39, 36); p.closePath();
        rim(g, p, u, 12); g.fillStyle = '#5b7bd6'; g.fill(p);
        break;
      }
      default: {
        const s = STAMP[k];
        if (!s || !s.text) break;
        const w = s.w, h = s.h;
        const p = new Path2D();
        const r = h / 2;
        p.moveTo(r, 0); p.lineTo(w - r, 0); p.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2); p.lineTo(r, h); p.arc(r, r, r, Math.PI / 2, Math.PI * 1.5); p.closePath();
        rim(g, p, u, 10); g.fillStyle = s.color; g.fill(p);
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `800 34px ${FONT}`;
        g.fillText(s.text, w / 2, h / 2 + 1.5, w - 26);
      }
    }
  }
  // 動くかざりの小さい絵
  function paintBit(g, k) {
    if (k === 'hearts') {
      const p = new Path2D('M50 88C24 70 7 53 9 33 11 15 31 7 43 16 46 19 48 22 50 26 52 22 54 19 57 16 69 7 89 15 91 33 93 53 76 70 50 88Z');
      g.fillStyle = '#ff7d96'; g.fill(p);
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.ellipse(28, 30, 9, 5, -0.7, 0, Math.PI * 2); g.fill();
    } else if (k === 'kira') {
      const gr = g.createRadialGradient(50, 50, 0, 50, 50, 48);
      gr.addColorStop(0, 'rgba(255,250,220,0.9)'); gr.addColorStop(1, 'rgba(255,240,180,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 100, 100);
      const p = new Path2D(); starPath(p, 50, 50, 46, 7, 4);
      g.fillStyle = '#fffbe6'; g.fill(p);
    } else {
      const p = new Path2D('M50 6C72 22 80 52 66 78 60 89 50 94 50 94 50 94 40 89 34 78 20 52 28 22 50 6Z');
      g.fillStyle = '#ffc4d4'; g.fill(p);
      g.strokeStyle = 'rgba(230,120,150,0.5)'; g.lineWidth = 3; g.beginPath(); g.moveTo(50, 20); g.lineTo(50, 82); g.stroke();
    }
  }
  // 描いた絵は大きさごとに取っておき、毎コマ描き直さない
  const sprites = new Map();
  function sprite(kind, k, px) {
    px = Math.max(8, Math.round(px));
    const key = `${kind}:${k}:${px}`;
    let c = sprites.get(key);
    if (c) return c;
    const s = kind === 'stamp' ? STAMP[k] : null;
    const wu = (s && s.w) || 100, hu = (s && s.h) || 100, pad = kind === 'stamp' ? 12 : 0, u = px / 100;
    c = makeCanvas(Math.ceil((wu + pad * 2) * u), Math.ceil((hu + pad * 2) * u));
    const g = c.getContext('2d');
    g.scale(u, u); g.translate(pad, pad);
    if (kind === 'stamp') paintStamp(g, k, u); else paintBit(g, k);
    if (sprites.size > 120) sprites.clear();
    sprites.set(key, c);
    return c;
  }

  // スタンプの場所：画面の短い辺を基準にするので、横・縦・正方形のどれでもはみ出さない
  function stampSpot(photo, i, W, H, s) {
    const d = photo.deco, def = STAMP[d.stamp];
    const base = Math.min(W, H), S = base * 0.22;
    const w = ((def.w || 100) / 100) * S, h = ((def.h || 100) / 100) * S, m = base * 0.07;
    const titled = i === 0 && (s.title || s.subtitle);
    const cx = d.pos[1] === 'l' ? m + w / 2 : W - m - w / 2;
    const cy = d.pos[0] === 't' ? m + h / 2 : H - m - h / 2 - (titled ? base * 0.3 : 0);
    return { cx, cy, S };
  }

  // local：その写真が出はじめてからの秒数。still：止めているとき（全部出た状態で見せる）
  function drawDeco(i, local, alpha, W, H, s, still) {
    const photo = state.photos[i];
    if (!photo || !hasDeco(photo) || alpha <= 0.01) return;
    const d = photo.deco, base = Math.min(W, H), span = s.dur + Math.min(0.9, s.dur * 0.3);
    ctx.save();
    // 動くかざり（写真の上・スタンプの下）
    if (d.move !== 'none') drawMove(photo, d.move, still ? span * 0.42 : local, span, alpha, W, H, base);
    // スタンプ：0.3秒後にポンと出て、かすかにゆれる
    if (d.stamp && STAMP[d.stamp]) {
      const { cx, cy, S } = stampSpot(photo, i, W, H, s);
      const u = still ? 1 : clamp((local - 0.3) / 0.45, 0, 1);
      if (u > 0) {
        const kIdx = STAMPS.indexOf(STAMP[d.stamp]);
        const rot = ((hash01(photo.id * 31 + kIdx) - 0.5) * 16 + (still ? 0 : Math.sin(local * 2.4) * 1.6)) * Math.PI / 180;
        const sc = backOut(u);
        const spr = sprite('stamp', d.stamp, S);
        ctx.globalAlpha = alpha * clamp(u * 3, 0, 1);
        ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(sc, sc);
        ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    if (d.say) drawSay(photo, i, d, still ? 1 : clamp((local - 0.55) / 0.4, 0, 1), alpha, W, H, s, base);
    ctx.restore();
  }

  function drawMove(photo, kind, L, span, alpha, W, H, base) {
    const k = clamp(span / 3.6, 0.6, 1.4);
    const seed = photo.id * 101 + (kind === 'hearts' ? 1 : kind === 'kira' ? 2 : 3);
    const r = (j, n) => hash01(seed * 977 + j * 13 + n);
    if (kind === 'hearts') {
      for (let j = 0; j < 11; j++) {
        const start = 0.25 * k + r(j, 1) * 1.5 * k, dur = 2.3 * k, u = (L - start) / dur;
        if (u <= 0 || u >= 1) continue;
        const size = base * (0.055 + 0.04 * r(j, 2));
        const x = W * (0.1 + 0.8 * r(j, 3)) + Math.sin(u * 5 + j) * base * 0.03;
        const y = H * 1.04 - u * H * (0.55 + 0.3 * r(j, 4));
        const a = clamp(Math.min(u / 0.12, (1 - u) / 0.3), 0, 1) * 0.9;
        put(sprite('bit', 'hearts', size), x, y, Math.sin(u * 4 + j) * 0.25, 0.8 + 0.25 * u, a * alpha);
      }
    } else if (kind === 'kira') {
      for (let j = 0; j < 16; j++) {
        const start = 0.2 * k + r(j, 1) * 2.4 * k, dur = 0.9 * k, u = (L - start) / dur;
        if (u <= 0 || u >= 1) continue;
        const size = base * (0.07 + 0.07 * r(j, 2));
        const x = W * (0.06 + 0.88 * r(j, 3)), y = H * (0.06 + 0.88 * r(j, 4));
        put(sprite('bit', 'kira', size), x, y, u * 1.2, Math.sin(u * Math.PI), alpha);
      }
    } else {
      for (let j = 0; j < 18; j++) {
        const start = r(j, 1) * 1.6 * k, dur = 3 * k, u = (L - start) / dur;
        if (u <= 0 || u >= 1) continue;
        const size = base * (0.034 + 0.026 * r(j, 2));
        const x = W * (-0.05 + 0.95 * r(j, 3)) + u * W * 0.18 + Math.sin(u * 6 + j) * base * 0.04;
        const y = -H * 0.06 + u * H * 1.12;
        const a = clamp(Math.min(u / 0.1, (1 - u) / 0.15), 0, 1) * 0.92;
        put(sprite('bit', 'petals', size), x, y, u * 5 * (r(j, 4) < 0.5 ? 1 : -1) + j, 1, a * alpha);
      }
    }
  }
  function put(spr, x, y, rot, sc, a) {
    if (sc <= 0 || a <= 0) return;
    ctx.globalAlpha = a;
    ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sc, sc);
    ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ひとこと：白い吹き出し。スタンプと重ならない上の角に出す
  function drawSay(photo, i, d, u, alpha, W, H, s, base) {
    if (u <= 0) return;
    const fs = base * 0.058;
    ctx.font = `800 ${Math.round(fs)}px ${FONT}`;
    const tw = Math.min(ctx.measureText(d.say).width, W * 0.66);
    const padX = fs * 0.75, bw = tw + padX * 2, bh = fs * 1.75, m = base * 0.07;
    const left = !(d.stamp && d.pos === 'tl');
    const x = left ? m : W - m - bw, y = m;
    const ax = left ? x + bh * 0.9 : x + bw - bh * 0.9, ay = y + bh;
    ctx.save();
    ctx.globalAlpha = alpha * clamp(u * 3, 0, 1);
    const sc = backOut(u);
    ctx.translate(ax, ay); ctx.scale(sc, sc); ctx.translate(-ax, -ay);
    const r = bh / 2, p = new Path2D();
    p.moveTo(x + r, y); p.lineTo(x + bw - r, y); p.arc(x + bw - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    p.lineTo(ax + fs * 0.35, y + bh); p.lineTo(ax - (left ? fs * 0.25 : -fs * 0.25), y + bh + fs * 0.55); p.lineTo(ax - fs * 0.35, y + bh);
    p.lineTo(x + r, y + bh); p.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5); p.closePath();
    ctx.shadowColor = 'rgba(0,0,0,0.28)'; ctx.shadowBlur = base * 0.02; ctx.shadowOffsetY = base * 0.005;
    ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fill(p);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#1d2433'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(d.say, x + padX, y + bh / 2 + fs * 0.04, tw);
    ctx.restore();
  }

  // ---------- 描画 ----------
  function drawCover(c, src, sw, sh, x, y, w, h) {
    const k = Math.max(w / sw, h / sh);
    const cw = w / k, ch = h / k;
    c.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
  }

  // フル解像度のビットマップは前後数枚だけ保持する（メモリ対策）
  const cache = new Map();
  function want(i) {
    const p = state.photos[i];
    if (!p) return Promise.resolve();
    let e = cache.get(p.id);
    if (e && e.look !== choice.filter) { dropCache(p.id); e = null; } // 色あいを変えたら作り直す
    if (!e) {
      e = { bmp: null, promise: null, look: choice.filter };
      const f = lookOf(choice.filter);
      const alive = () => cache.get(p.id) === e;
      e.promise = createImageBitmap(p.blob).then(async (b) => {
        if (f && alive()) { const t = await tintLarge(b, f, alive); b.close(); b = t; }
        if (!b) return;
        if (alive()) { e.bmp = b; if (!state.playing) draw(state.pos); } else b.close();
      }).catch(() => {});
      cache.set(p.id, e);
    }
    return e.promise;
  }
  function dropCache(id) {
    const e = cache.get(id);
    if (e) { if (e.bmp) e.bmp.close(); cache.delete(id); }
  }
  function trimCache(keep) {
    for (const id of Array.from(cache.keys())) if (!keep.has(id)) dropCache(id);
  }

  let slideDur = 3.5;
  function drawSlide(i, p, alpha, W, H) {
    const photo = state.photos[i];
    if (!photo || alpha <= 0) return;
    const e = cache.get(photo.id);
    const small = smallOf(photo);
    const src = e && e.bmp ? e.bmp : small.tiny;
    const sw = src.width, sh = src.height;
    const ar = photo.w / photo.h, far = W / H;
    const loss = 1 - Math.min(ar, far) / Math.max(ar, far);
    const q = ease(clamp(p, 0, 1));
    const zin = i % 2 === 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (loss >= 0.3 && choice.fit !== 'whole') {
      // 形が合わない写真：切れる方向へゆっくり流して見せる（iPhoneのスライドショーと同じ考え方）。
      // 画面いっぱいに映るので、ぼかし背景よりくっきり見える
      const k = Math.max(W / sw, H / sh) * 1.03;
      const ow = sw * k - W, oh = sh * k - H;
      const vertical = oh > ow;
      const over = vertical ? oh : ow, dim = vertical ? H : W;
      // 速くなりすぎないよう、動く量に上限をつける。縦の写真は少し上（顔があることが多い）を中心にする
      const travel = Math.min(over * 0.8, dim * 0.1 * (slideDur + 0.9));
      const start = clamp(over * (vertical ? 0.4 : 0.5) - travel / 2, 0, over - travel);
      const pp = clamp(p, 0, 1);
      const pos = start + travel * (zin ? pp : 1 - pp);
      ctx.drawImage(src, vertical ? -ow / 2 : -pos, vertical ? -pos : -oh / 2, sw * k, sh * k);
    } else if (loss < 0.3) {
      // 画面いっぱい＋ゆっくりズームとパン
      const z = 1.06 + 0.08 * (zin ? q : 1 - q);
      const ang = i * 2.399;
      const dx = Math.cos(ang) * (q - 0.5) * 0.045 * W, dy = Math.sin(ang) * (q - 0.5) * 0.045 * H;
      const k = Math.max(W / sw, H / sh) * z;
      ctx.drawImage(src, (W - sw * k) / 2 + dx, (H - sh * k) / 2 + dy, sw * k, sh * k);
    } else {
      // 縦横比が合わない写真は切らずに、ぼかした同じ写真を背景に敷く
      const t = small.bg || small.tiny;
      const bk = Math.max(W / t.width, H / t.height) * 1.3;
      ctx.drawImage(t, (W - t.width * bk) / 2, (H - t.height * bk) / 2, t.width * bk, t.height * bk);
      const z = 0.9 + 0.05 * (zin ? q : 1 - q);
      const k = Math.min(W / sw, H / sh) * z;
      const w = sw * k, h = sh * k, x = (W - w) / 2, y = (H - h) / 2;
      ctx.shadowColor = 'rgba(0,0,0,0.38)'; ctx.shadowBlur = H * 0.035; ctx.shadowOffsetY = H * 0.008;
      ctx.fillStyle = '#f4f2ee';
      const m = Math.max(2, Math.round(H * 0.003));
      ctx.fillRect(x - m, y - m, w + m * 2, h + m * 2);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.drawImage(src, x, y, w, h);
    }
    ctx.restore();
  }

  function fitFont(text, weight, size, maxW) {
    let fs = size;
    for (let k = 0; k < 12; k++) {
      ctx.font = `${weight} ${Math.round(fs)}px ${FONT}`;
      if (ctx.measureText(text).width <= maxW) break;
      fs *= 0.9;
    }
    return fs;
  }

  function drawTitle(t, W, H, s) {
    if (!s.title && !s.subtitle) return;
    const show = Math.min(3.6, Math.max(2.2, s.dur));
    const a = clamp(Math.min((t - 0.25) / 0.6, (show - t) / 0.6), 0, 1);
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a;
    const g = ctx.createLinearGradient(0, H * 0.5, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.5, W, H * 0.5);
    const pad = W * 0.07, maxW = W - pad * 2, base = Math.min(W, H);
    let y = H - base * 0.09;
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = base * 0.02;
    if (s.subtitle) {
      const fs = fitFont(s.subtitle, 500, base * 0.042, maxW);
      ctx.fillText(s.subtitle, pad, y);
      y -= fs * 1.55;
    }
    if (s.title) {
      // 長いタイトルは小さくしすぎず、2行に分ける
      ctx.font = `700 ${Math.round(base * 0.1)}px ${FONT}`;
      let lines = [s.title];
      if (ctx.measureText(s.title).width > maxW * 1.25 && s.title.length >= 8) {
        const mid = s.title.length / 2;
        let cut = -1;
        for (let k = 1; k < s.title.length - 1; k++) if (/[\s　・／]/.test(s.title[k]) && (cut < 0 || Math.abs(k - mid) < Math.abs(cut - mid))) cut = k;
        if (cut < 0) cut = Math.ceil(mid);
        lines = [s.title.slice(0, cut).trim(), s.title.slice(cut).trim()].filter(Boolean);
      }
      const fs = Math.min(...lines.map((l) => fitFont(l, 700, base * (lines.length > 1 ? 0.085 : 0.1), maxW)));
      ctx.font = `700 ${Math.round(fs)}px ${FONT}`;
      lines.forEach((l, k) => ctx.fillText(l, pad, y - (lines.length - 1 - k) * fs * 1.28));
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(pad, y - (lines.length - 1) * fs * 1.28 - fs * 1.22, base * 0.07, Math.max(3, base * 0.006));
    }
    ctx.restore();
  }

  function draw(t) {
    const s = settings();
    const [W, H] = s.size;
    const n = state.photos.length;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0d0b0a';
    ctx.fillRect(0, 0, W, H);
    if (!n) {
      ctx.fillStyle = '#8d8073';
      ctx.font = `500 ${Math.round(Math.min(W, H) * 0.045)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('写真を選ぶと、ここに動画が出ます', W / 2, H / 2);
      ctx.textAlign = 'start';
      return;
    }
    const D = s.dur, X = Math.min(0.9, D * 0.3), T = n * D;
    slideDur = D;
    t = clamp(t, 0, T);
    const i = Math.min(n - 1, Math.floor(t / D));
    const local = t - i * D;
    markNow(i);
    const keep = new Set();
    for (let j = i - 1; j <= i + 2; j++) if (state.photos[j]) { keep.add(state.photos[j].id); want(j); }
    trimCache(keep);
    // 止めているときは、切りかわりの途中ではなく、その写真だけを見せる
    const still = !state.playing;
    const fadeIn = i > 0 ? (still ? 1 : clamp(local / X, 0, 1)) : (state.playing ? clamp(t / 0.5, 0, 1) : 1);
    if (i > 0 && fadeIn < 1) drawSlide(i - 1, (local + D) / (D + X), 1, W, H);
    drawSlide(i, local / (D + X), fadeIn, W, H);
    drawLook(t, W, H);
    if (i > 0 && fadeIn < 1) drawDeco(i - 1, local + D, 1 - fadeIn, W, H, s, false);
    drawDeco(i, local, fadeIn, W, H, s, still);
    drawTitle(t, W, H, s);
    const end = clamp((t - (T - 1.2)) / 1.2, 0, 1);
    if (end > 0) { ctx.fillStyle = `rgba(13,11,10,${end})`; ctx.fillRect(0, 0, W, H); }
  }

  // ---------- 音 ----------
  const audio = { ctx: null, fade: null, master: null, src: null, buffers: new Map(), raw: new Map(), start: 0, perfStart: 0 };

  function ensureAudio() {
    if (audio.ctx) return audio.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      audio.ctx = new AC();
      audio.fade = audio.ctx.createGain();
      audio.master = audio.ctx.createGain();
      audio.fade.connect(audio.master);
      audio.master.connect(audio.ctx.destination);
      audio.master.gain.value = state.muted ? 0 : 1;
    } catch (_) { audio.ctx = null; }
    return audio.ctx;
  }

  // 曲ファイルの取得（同じサイト内のみ）。再生前に先読みしておける
  function fetchRaw(key) {
    if (!Object.hasOwn(TRACKS, key)) return Promise.resolve(null);
    if (!audio.raw.has(key)) {
      audio.raw.set(key, fetch(TRACKS[key].file, { credentials: 'omit' })
        .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
        .catch(() => { audio.raw.delete(key); return null; }));
    }
    return audio.raw.get(key);
  }
  function loadTrack(key) {
    if (!key || !Object.hasOwn(TRACKS, key) || !audio.ctx) return Promise.resolve(null);
    if (!audio.buffers.has(key)) {
      const p = fetchRaw(key)
        .then((ab) => { if (!ab) throw new Error('no data'); return audio.ctx.decodeAudioData(ab.slice(0)); })
        .catch(() => { audio.buffers.delete(key); return null; });
      audio.buffers.set(key, p);
    }
    return audio.buffers.get(key);
  }

  function stopSource() {
    if (audio.src) { try { audio.src.stop(); } catch (_) {} audio.src.disconnect(); audio.src = null; }
  }

  function startClock(from, buffer) {
    const T = totalTime();
    audio.perfStart = performance.now() - from * 1000;
    if (!audio.ctx) return;
    const now = audio.ctx.currentTime;
    audio.start = now - from;
    stopSource();
    const g = audio.fade.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    if (!buffer) return;
    const src = audio.ctx.createBufferSource();
    src.buffer = buffer; src.loop = true;
    src.connect(audio.fade);
    const endAt = audio.start + T;
    const fadeLen = Math.min(2.5, T * 0.4);
    const up = Math.min(from < 0.1 ? 1.2 : 0.35, Math.max(0.02, (endAt - now) / 2));
    g.linearRampToValueAtTime(1, now + up);
    g.setValueAtTime(1, Math.max(now + up, endAt - fadeLen));
    g.linearRampToValueAtTime(0, Math.max(now + up + 0.01, endAt));
    src.start(now, from % buffer.duration);
    audio.src = src;
  }
  const clock = () => (audio.ctx && audio.ctx.state === 'running'
    ? audio.ctx.currentTime - audio.start
    : (performance.now() - audio.perfStart) / 1000);

  // ---------- 再生（0秒から始めるときは同時に録画する） ----------
  let raf = 0, playToken = 0;
  let previewEnd = 0; // かざりの見本を見せるとき：この時刻で止める

  async function play(from, opts) {
    opts = opts || {};
    previewEnd = opts.until || 0;
    if (!state.photos.length || state.loading) return false;
    const token = ++playToken;
    const s = settings();
    const T = totalTime();
    if (!(from >= 0) || from >= T - 0.05) from = 0;
    // まだ一度も画面に触れていないときは音を出せないので、再生ボタンを待つ
    if (opts.auto && !audio.ctx && navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
    const ac = ensureAudio();
    if (ac && ac.state !== 'running') { try { await within(ac.resume(), 400); } catch (_) {} }
    if (token !== playToken) return false;
    // 自動再生で音がまだ許可されていない場合は、再生ボタンを押してもらう
    if (opts.auto && ac && ac.state !== 'running') return false;
    let buffer = null;
    if (s.track && ac && ac.state === 'running') {
      const LOADING = '曲を読み込んでいます…';
      const slow = setTimeout(() => { if (token === playToken && !rawOf(el.playStatus)) hint(LOADING); }, 500);
      buffer = await loadTrack(s.track);
      clearTimeout(slow);
      if (rawOf(el.playStatus) === LOADING) hint('');
      if (token !== playToken) return false;
      if (!buffer) hint('曲を読み込めなかったので、音なしで再生しています');
    }
    await Promise.all([want(Math.floor(from / s.dur)), want(Math.floor(from / s.dur) + 1)]);
    if (token !== playToken) return false;
    if (s.track && (!ac || ac.state !== 'running')) hint('音が出ないときは、一度止めて ▶ を押してください');
    startClock(from, buffer);
    if (buffer && !state.saidMute && /iPhone|iPad|iPod/.test(navigator.userAgent) && !rawOf(el.playStatus)) {
      state.saidMute = true; // iPhoneは消音モードだとWebの音が出ない
      hint('音が出ないときは、消音モード（マナーモード）を解除してください');
    }
    state.playing = true;
    keepAwake(true);
    if (rec.paused) {
      // 止めたところからの再開なら、録画もつづきから
      if (Math.abs(from - rec.pausedAt) < 0.15 && !state.ready && rec.recorder) {
        try { rec.recorder.resume(); rec.paused = false; } catch (_) { abortRecording(); }
      } else abortRecording();
    } else if (from === 0 && !state.ready && (opts.record !== false)) {
      const ok = beginRecording(!!buffer);
      if (!ok && state.exporting) { cancelWait('このブラウザでは動画を作れません。Safari か Chrome で開いてください。'); return false; }
    }
    updateButtons();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    return true;
  }

  // 再生中・動画の作成中に画面が暗くなって中断されないようにする（対応端末のみ）
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on) {
        if (!wake && navigator.wakeLock) {
          wake = await navigator.wakeLock.request('screen');
          wake.addEventListener('release', () => { wake = null; });
        }
      } else if (wake) { const w = wake; wake = null; await w.release(); }
    } catch (_) { wake = null; }
  }

  const meter = { t0: 0, n: 0, done: false };
  function tick() {
    if (!state.playing) return;
    const T = totalTime();
    const t = clock();
    // なめらかさの確認（最初の再生で一度だけ）：1.5秒で36コマ（毎秒24コマ）に届かなければ軽いサイズへ
    if (!meter.done && !state.light) {
      const now = performance.now();
      if (!meter.t0) { meter.t0 = now; meter.n = 0; }
      meter.n++;
      if (now - meter.t0 >= 1500) {
        meter.done = true;
        if (meter.n < 36 && !document.hidden) {
          state.light = true;
          // かざりの見本を見せている途中なら、サイズだけ切りかえてそのまま続ける
          if (previewEnd) refresh();
          else {
            stop(); invalidate();
            state.pos = 0; refresh();
            play(0);
            return;
          }
        }
      }
    }
    if (previewEnd && t >= previewEnd) {
      previewEnd = 0;
      stop();
      refresh();
      return;
    }
    if (t >= T) {
      draw(T);
      syncSeek(T, T);
      if (rec.active) rec.finishing = true;
      halt();
      if (rec.finishing) finishRecording();
      else { state.pos = 0; refresh(); }
      return;
    }
    draw(t);
    state.pos = t;
    syncSeek(t, T);
    raf = requestAnimationFrame(tick);
  }

  function halt(keepRecording) {
    playToken++;
    state.playing = false;
    keepAwake(false);
    cancelAnimationFrame(raf);
    stopSource();
    // 最後まで行かずに止まった録画は捨てる（一時停止のときは残す）
    if (rec.active && !rec.finishing && !keepRecording) abortRecording();
    updateButtons();
  }
  // 一時停止：準備中の動画があれば録画も一時停止にして、つづきから再開できるようにする
  function pause() {
    if (!state.playing) return;
    const r = rec.recorder;
    if (rec.active && !rec.finishing && r && r.state === 'recording') {
      state.pos = clamp(clock(), 0, totalTime());
      try { r.pause(); } catch (_) { stop(); return; }
      rec.paused = true; rec.pausedAt = state.pos;
      halt(true);
    } else stop();
  }
  function stop() {
    if (state.playing) state.pos = clamp(clock(), 0, totalTime());
    halt();
  }
  function toggle() {
    if (state.exporting) return;
    if (state.playing) pause(); else { hint(''); play(state.pos); }
  }
  async function autoStart() {
    const ok = await play(0, { auto: true });
    if (!ok && !state.playing) hint('▶ を押すと始まります');
  }
  const paintSeek = () => el.seek.style.setProperty('--v', `${Number(el.seek.value) / 10}%`);
  function syncSeek(t, T) {
    el.seek.value = String(Math.round((t / T) * 1000));
    paintSeek();
    setText(el.time, state.playing ? fmt(t) : stoppedLabel());
    if (state.exporting) {
      el.recBar.value = clamp(t / T, 0, 1);
      const left = `あと${Math.max(1, Math.ceil(T - t))}秒　このままお待ちください`;
      if (rawOf(el.recLeft) !== left) setText(el.recLeft, left);
    }
    updateSend(t, T);
  }

  // 動画の表示サイズ：空いている広さに入る最大にする（再生バーは必ずすぐ下に付く）
  function layout() {
    if (el.player.hidden) return;
    const [W, H] = settings().size;
    const aw = el.view.clientWidth;
    let ah = el.view.clientHeight - el.view.querySelector('.controls').offsetHeight;
    if (ah < 90) ah = document.body.classList.contains('editing') && window.innerHeight > window.innerWidth ? Math.max(ah, 60) : window.innerHeight * 0.6; // 背の低い画面（横向きなど）
    const k = Math.min(aw / W, ah / H);
    // 動画を小さくせずに置ける空きがあるときだけ、写真の帯を出す
    const stripH = window.innerWidth >= 600 && window.innerHeight >= 600 ? 80 : 64;
    const showStrip = state.photos.length > 1 && ah - H * k >= stripH + 8 && !document.body.classList.contains('typing');
    if (el.strip.hidden === showStrip) el.strip.hidden = !showStrip;
    el.stage.style.width = `${Math.floor(W * k)}px`;
    el.stage.style.height = `${Math.floor(H * k)}px`;
  }

  function refresh() {
    const s = settings();
    if (el.canvas.width !== s.size[0] || el.canvas.height !== s.size[1]) {
      el.canvas.width = s.size[0]; el.canvas.height = s.size[1];
    }
    const T = totalTime();
    state.pos = clamp(state.pos, 0, T);
    draw(state.pos);
    syncSeek(state.photos.length ? state.pos : 0, T);
    updateButtons();
    layout();
  }

  const currentIndex = () => clamp(Math.floor((state.playing ? clock() : state.pos) / settings().dur), 0, Math.max(0, state.photos.length - 1));
  // 止めているとき：途中なら「何枚目か」、頭なら全体の長さ
  const stoppedLabel = () => (state.pos > 0.5 && state.photos.length
    ? `${currentIndex() + 1}/${state.photos.length}枚目`
    : fmt(totalTime()));

  function updateButtons() {
    const has = state.photos.length > 0;
    const busy = state.exporting || state.loading;
    el.start.hidden = has || state.loading;
    el.loading.hidden = !state.loading;
    el.player.hidden = !has || state.loading;
    el.app.dataset.mode = el.player.hidden ? 'start' : 'player';
    // ブラウザの上の帯の色も、画面のいちばん上の色に合わせる
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const top = el.app.dataset.mode === 'start' ? (dark ? '#1b2836' : '#d7f0fc') : (dark ? '#121722' : '#f1f6fc');
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) if (m.content !== top) m.content = top;
    // LINEの中では、最初の画面は下のカードが案内するので、上のお知らせは動画の画面でだけ出す
    if (document.body.classList.contains('in-line')) el.tip.hidden = el.player.hidden;
    el.play.toggleAttribute('data-playing', state.playing);
    el.play.setAttribute('aria-label', state.playing ? '一時停止' : '再生');
    el.canvas.setAttribute('aria-label', `${state.photos.length}枚の動画。${state.playing ? '再生中。押すと止まります' : '停止中。押すと再生します'}。左右にスワイプで前後の写真`);
    el.bigPlay.hidden = state.playing || !has || state.exporting || !el.panel.hidden;
    for (const b of [el.play, el.seek, el.send, el.poster, el.title, el.file, el.sortTime, el.clear, el.adjust]) b.disabled = busy;
    if (!$('confirm').hidden) el.clear.disabled = true;
    if (state.exporting) for (const b of el.thumbs.querySelectorAll('button')) b.disabled = true;
    const full = state.photos.length >= LIMITS.maxFiles;
    el.file.disabled = busy || full || !!state.unsupported;
    setText($('add'), full ? `${LIMITS.maxFiles}枚でいっぱい` : '＋ 写真を追加');
    $('add').classList.toggle('off', busy || full);
    setText($('tap-hint'), state.ready && state.pos < 0.5 ? 'もう一度見る' : (state.pos > 0.5 ? '続きを見る' : '押すと再生')); // 30
    setText($('dur-total'), has ? `（全部で ${fmt(totalTime())}）` : '');
    setText(el.info, has ? `${state.photos.length}枚・${fmt(totalTime())}` : '');
    syncEditButton();
    $('drop-now').hidden = state.playing || state.photos.length < 2 || busy;
    $('mute').hidden = !has || !settings().track;
    renderChips();
    if (!state.playing) paintSwatches();
    if (!state.playing) setText(el.time, stoppedLabel());
    updateSend(state.playing ? clock() : state.pos, totalTime());
  }

  // 送るボタンの中に、動画の準備状況を出す（別の場所に説明文を置かない）
  let canRecord = null;
  function updateSend(t, T) {
    const st = state.ready ? 'ready' : (rec.active ? 'preparing' : 'idle');
    if (el.send.dataset.state !== st) el.send.dataset.state = st;
    if (canRecord === null) canRecord = !!(pickMime(true) || pickMime(false));
    if (!canRecord) {
      el.send.dataset.state = 'none';
      setText(el.sendLabel, 'この端末では動画にできません');
      setText(el.sendSub, 'Safari か Chrome で開くと送れます');
      return;
    }
    const left = Math.max(1, Math.ceil(T - t));
    let label, sub = '';
    if (st === 'ready') {
      const mb = state.ready.blob.size / 1048576, size = mb < 10 ? mb.toFixed(1) : Math.round(mb);
      label = CAN_SHARE ? 'LINEに送る' : '動画を保存';
      sub = CAN_SHARE ? `できました（${size}MB）。押すと送り先を選べます` : `できました（${size}MB）。押すと保存します`;
    } else if (st === 'preparing') {
      el.send.style.setProperty('--p', String(clamp(t / T, 0, 1)));
      label = rec.paused ? '続きから作る' : '動画を作っています';
      sub = `あと${left}秒`;
    } else {
      label = `動画を作る（${Math.ceil(T)}秒）`;
      sub = state.photos.length ? '押すと再生しながら仕上げます' : '';
    }
    setText(el.sendLabel, label);
    el.send.dataset.kind = st === 'ready' ? (CAN_SHARE ? 'share' : 'save') : 'make';
    $('ic-make').toggleAttribute('hidden', st === 'ready');
    $('ic-send').toggleAttribute('hidden', !(st === 'ready' && CAN_SHARE));
    $('ic-save').toggleAttribute('hidden', !(st === 'ready' && !CAN_SHARE));
    // 3. iPhoneの共有画面にLINEが出ないときの案内（送るまでの間だけ）
    $('share-hint').hidden = !(st === 'ready' && CAN_SHARE && IS_IOS && !state.sent);
    if (rawOf(el.sendSub) !== sub) setText(el.sendSub, sub);
    $('keep').hidden = !(st === 'ready' && CAN_SHARE);
    el.send.classList.toggle('go', st === 'ready' && !state.sent);
    el.bigPlay.classList.toggle('call', !state.playing && state.pos < 0.5 && !state.ready);
  }

  // ---------- 録画（動画化） ----------
  const rec = { recorder: null, chunks: [], dest: null, stream: null, fmt: null, active: false, finishing: false, cancelled: false, paused: false, pausedAt: 0 };

  // LINEやiPhoneで確実に再生できる H.264 + AAC のMP4を最優先にする
  function pickMime(withAudio) {
    if (!window.MediaRecorder || !el.canvas.captureStream) return null;
    const ok = (m) => MediaRecorder.isTypeSupported(m);
    const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(ok);
    const h264 = ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'avc1.42E01E', 'avc1']; // フルHDに足りるレベルを先に
    if (withAudio) {
      for (const v of h264) if (ok(`video/mp4;codecs=${v},mp4a.40.2`)) return { mime: `video/mp4;codecs=${v},mp4a.40.2`, ext: 'mp4', level: 'best' };
    } else {
      for (const v of h264) if (ok(`video/mp4;codecs=${v}`)) return { mime: `video/mp4;codecs=${v}`, ext: 'mp4', level: 'best' };
    }
    // Safari は video/mp4 だけを申告し、中身は H.264 + AAC になる
    if (!webm && ok('video/mp4')) return { mime: 'video/mp4', ext: 'mp4', level: 'best' };
    for (const v of h264) if (ok(`video/mp4;codecs=${v},opus`)) return { mime: `video/mp4;codecs=${v},opus`, ext: 'mp4', level: 'opus' };
    if (webm) return { mime: webm, ext: 'webm', level: 'webm' };
    return null;
  }

  function beginRecording(withAudio) {
    releaseRecording();
    const f = pickMime(withAudio);
    if (!f) return false;
    try {
      const tracks = el.canvas.captureStream(FPS).getVideoTracks();
      if (withAudio && audio.ctx) {
        rec.dest = audio.ctx.createMediaStreamDestination();
        audio.fade.connect(rec.dest);
        tracks.push(...rec.dest.stream.getAudioTracks());
      }
      rec.stream = new MediaStream(tracks);
      const r = new MediaRecorder(rec.stream, { mimeType: f.mime, videoBitsPerSecond: state.light ? 5000000 : (totalTime() > 75 ? 6000000 : 8000000), audioBitsPerSecond: 128000 });
      rec.chunks = []; rec.fmt = f; rec.cancelled = false; rec.finishing = false;
      r.ondataavailable = (e) => { if (r === rec.recorder && e.data && e.data.size) rec.chunks.push(e.data); };
      r.onerror = () => { if (r === rec.recorder) abortRecording(); };
      r.onstop = () => { if (r === rec.recorder) onRecorderStop(); };
      rec.recorder = r;
      r.start(1000);
      rec.active = true;
      return true;
    } catch (_) {
      releaseRecording();
      return false;
    }
  }

  function releaseRecording() {
    if (rec.stream) for (const t of rec.stream.getTracks()) t.stop();
    if (rec.dest) { try { audio.fade.disconnect(rec.dest); } catch (_) {} }
    rec.recorder = null; rec.stream = null; rec.dest = null; rec.chunks = [];
    rec.active = false; rec.finishing = false; rec.paused = false;
  }

  function finishRecording() {
    // 最後の黒いフレームまで確実に入るよう、少し待ってから止める
    const r = rec.recorder;
    setTimeout(() => { if (r === rec.recorder && r.state !== 'inactive') r.stop(); }, 350);
  }

  function abortRecording() {
    const r = rec.recorder;
    rec.cancelled = true;
    releaseRecording();
    if (r && r.state !== 'inactive') { try { r.stop(); } catch (_) {} }
    if (state.exporting) endWait();
  }

  function onRecorderStop() {
    const chunks = rec.chunks, f = rec.fmt, cancelled = rec.cancelled;
    releaseRecording();
    const waited = state.exporting;
    if (waited) endWait();
    state.pos = 0; refresh();
    if (cancelled || !chunks.length || !f) return;
    const notes = {
      best: '',
      opus: 'この端末で作った動画は、古いiPhoneで音が出ないことがあります',
      webm: 'この端末ではWebM形式になります。LINEで再生できないときは、iPhoneのSafariかChromeで作ってください'
    };
    state.ready = {
      blob: new Blob(chunks, { type: f.ext === 'mp4' ? 'video/mp4' : 'video/webm' }),
      name: `${fileBase()}-${stamp()}.${f.ext}`,
      note: notes[f.level]
    };
    updateButtons();
    // できあがりは送るボタンが知らせる。形式に注意点があるときだけ一言そえる
    hint(state.ready.note);
    try { if (navigator.vibrate) navigator.vibrate(20); } catch (_) {}
    showInstallTip();
  }

  // 待ち画面（動画ができるまで操作をロックする）
  function beginWait() {
    state.exporting = true;
    el.rec.hidden = false;
    el.recBar.value = state.playing ? clamp(clock() / totalTime(), 0, 1) : 0;
    hint('');
    updateButtons();
    renderThumbs();
  }
  function endWait() {
    state.exporting = false;
    el.rec.hidden = true;
    updateButtons();
    renderThumbs();
  }
  function cancelWait(msg) {
    if (!state.exporting) return;
    endWait();
    stop();
    state.pos = 0; refresh();
    hint(msg || '動画の作成をやめました。');
  }

  // 「LINEに送る」：動画ができていればすぐ共有。まだなら、できあがりを待つ
  let lastSend = 0;
  async function send() {
    const now = performance.now();
    if (now - lastSend < 700) return; // 連打は1回として扱う
    lastSend = now;
    if (state.loading || state.exporting || !state.photos.length || canRecord === false) return;
    if (state.ready) {
      const file = makeFile(state.ready.blob, state.ready.name);
      if (canShareFile(file)) {
        try {
          await navigator.share({ files: [file] });
          state.sent = true; updateButtons();
          hint('送りました。もう一度送るときも同じボタンです');
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      stop();
      if (!CAN_SHARE) { download(state.ready.blob, state.ready.name); return; }
      showResult(state.ready.blob, state.ready.name, 'video', '「保存する」を押してから、LINEで送ってください');
      return;
    }
    if (!pickMime(true) && !pickMime(false)) {
      hint('このブラウザでは動画を作れません。Safari か Chrome で開いてください。');
      return;
    }
    closeResult();
    // まだ動画ができていないとき：暗い待ち画面は出さず、再生しながら作る。進み具合はこのボタンの中に出る
    const left = () => Math.max(1, Math.ceil(totalTime() - (state.playing ? clock() : state.pos)));
    if (rec.active && (state.playing || rec.finishing)) { hint(`あと${left()}秒でできあがります`); return; }
    if (rec.active && rec.paused) { hint(`続きを作ります（あと${left()}秒）`); play(state.pos); return; }
    stop();
    state.pos = 0;
    const ok = await play(0);
    if (ok) hint(`動画を作っています（${Math.ceil(totalTime())}秒）`);
    else hint('動画を作れませんでした。▶ を押してみてください');
  }

  // ---------- ポスター ----------
  const POSTER_ROWS = { 1: [1], 2: [1, 1], 3: [1, 2], 4: [1, 3], 5: [2, 3], 6: [1, 2, 3], 7: [2, 2, 3], 8: [2, 3, 3], 9: [3, 3, 3] };

  async function makePoster() {
    if (state.exporting || state.loading || !state.photos.length) return;
    stop();
    el.poster.disabled = true;
    hint('コラージュを作っています');
    try {
      const s = settings();
      const shape = Object.hasOwn(SIZES, choice.aspect) ? choice.aspect : autoShape();
      const W = 1080, H = shape === 'portrait' ? 1920 : shape === 'square' ? 1080 : 1350, c = makeCanvas(W, H), p = c.getContext('2d', { alpha: false });
      const tint = '#4069c0'; // コラージュの差し色は、サイトと同じ落ち着いた青にそろえる
      p.fillStyle = '#f6efe4'; p.fillRect(0, 0, W, H);
      p.fillStyle = tint; p.fillRect(0, 0, W, 14);
      const M = 64;
      let top = M + 20;
      p.fillStyle = '#2b2622'; p.textBaseline = 'alphabetic';
      const fit = (text, weight, size) => {
        let fs = size;
        for (let k = 0; k < 12; k++) { p.font = `${weight} ${Math.round(fs)}px ${FONT}`; if (p.measureText(text).width <= W - M * 2) break; fs *= 0.9; }
        return fs;
      };
      if (s.title) { const fs = fit(s.title, 700, 84); top += fs; p.fillText(s.title, M, top); top += 22; }
      if (s.subtitle) { const fs = fit(s.subtitle, 500, 32); top += fs; p.fillStyle = '#6b6058'; p.fillText(s.subtitle, M, top); top += 20; }
      if (s.title || s.subtitle) { p.fillStyle = tint; p.fillRect(M, top + 4, 96, 8); top += 44; }

      const n = state.photos.length, k = Math.min(9, n);
      const picks = Array.from({ length: k }, (_, i) => state.photos[k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1))]);
      const rows = POSTER_ROWS[k];
      const weights = rows.map((cells) => (cells === 1 ? 1.7 : cells === 2 ? 1.25 : 1));
      const sum = weights.reduce((a, b) => a + b, 0);
      const gap = 18, areaH = H - top - M - gap * (rows.length - 1);
      let y = top, idx = 0;
      for (let r = 0; r < rows.length; r++) {
        const cells = rows[r], rh = (areaH * weights[r]) / sum, cw = (W - M * 2 - gap * (cells - 1)) / cells;
        for (let q = 0; q < cells; q++) {
          const photo = picks[idx++], x = M + q * (cw + gap);
          const bmp = await createImageBitmap(photo.blob);
          try {
            p.save();
            p.shadowColor = 'rgba(43,38,34,0.22)'; p.shadowBlur = 18; p.shadowOffsetY = 6;
            p.fillStyle = '#fff'; p.fillRect(x, y, cw, rh);
            p.restore();
            const f = lookOf(choice.filter);
            const img = f ? tintCanvas(bmp, bmp.width, bmp.height, f) : bmp;
            drawCover(p, img, img.width, img.height, x + 10, y + 10, cw - 20, rh - 20);
            if (img !== bmp) img.width = img.height = 0;
          } finally { bmp.close(); }
        }
        y += rh + gap;
      }
      const blob = await toBlob(c, 'image/png');
      c.width = c.height = 0;
      hint('');
      showResult(blob, `${fileBase()}-poster-${stamp()}.png`, 'image', '');
    } catch (_) {
      hint('コラージュを作れませんでした');
    } finally {
      updateButtons();
    }
  }

  // ---------- できあがりの表示・シェア ----------
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  // ファイル名：タイトルがあればそれを使う（あとで探しやすい）
  const fileBase = () => settings().title.replace(/[\\/:*?"<>|.\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'omoide';
  const makeFile = (blob, name) => { try { return new File([blob], name, { type: blob.type }); } catch (_) { return null; } };
  const canShareFile = (file) => {
    try { return !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (_) { return false; }
  };

  // 共有ボタンのない端末（PCなど）向け：ファイルとして保存する
  let lastDownloadUrl = null;
  function download(blob, name, viaPhone) {
    if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
    lastDownloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = lastDownloadUrl; a.download = name;
    a.click();
    hint(viaPhone ? '端末に保存しました' : '動画を保存しました。LINEの画面にドラッグすると送れます');
  }

  function closeResult() {
    el.result.hidden = true;
    el.resultMedia.replaceChildren();
    layout();
    el.save.removeAttribute('href');
    if (state.resultUrl) { URL.revokeObjectURL(state.resultUrl); state.resultUrl = null; }
    state.resultFile = null;
  }

  function showResult(blob, filename, kind, note) {
    closeResult();
    const url = URL.createObjectURL(blob);
    state.resultUrl = url;
    const file = makeFile(blob, filename);
    state.resultFile = file;
    let node;
    if (kind === 'video') {
      node = document.createElement('video');
      node.controls = true; node.loop = true; node.playsInline = true; node.preload = 'metadata';
    } else {
      node = document.createElement('img');
      node.alt = 'できあがったコラージュ';
    }
    node.src = url;
    el.resultMedia.append(node);
    setText(el.resultTitle, kind === 'video' ? '送れませんでした' : 'コラージュができました');
    // ポスターはここから送る。動画は上の「LINEに送る」1つにまとめる
    const can = kind === 'image' && canShareFile(file);
    el.share.hidden = !can;
    el.save.className = can ? 'btn line' : 'btn line strong';
    setText(el.resultNote, note);
    el.save.href = url;
    el.save.download = filename;
    setPanel(false);
    el.result.hidden = false;
    layout();
  }

  async function share() {
    if (!state.resultFile || !navigator.share) return;
    try {
      await navigator.share({ files: [state.resultFile] });
    } catch (e) {
      if (!e || e.name !== 'AbortError') setText(el.resultNote, '送れませんでした。「保存する」を押してから、LINEで送ってください');
    }
  }

  // ---------- ほかのアプリの「共有」から渡された写真を受け取る（ホーム画面に追加した場合） ----------
  async function takeShared() {
    if (!new URLSearchParams(location.search).has('shared')) {
      // 受け取られずに残った一時ファイルがあれば消しておく
      try { if (window.caches) await caches.delete('omoide-share-v1'); } catch (_) {}
      return;
    }
    try { history.replaceState(null, '', new URLSearchParams(location.search).has('kana') ? '?kana=1' : location.pathname); } catch (_) {}
    if (!window.caches) return;
    try {
      const cache = await caches.open('omoide-share-v1');
      const keys = await cache.keys();
      const files = [];
      for (const k of keys.slice(0, LIMITS.maxFiles)) {
        const res = await cache.match(k);
        if (!res) continue;
        const blob = await res.blob();
        files.push(new File([blob], '共有された写真', { lastModified: Number(res.headers.get('X-Last-Modified')) || 0 }));
      }
      await caches.delete('omoide-share-v1');
      if (files.length) await addFiles(files);
    } catch (_) {
      addError('共有された写真を受け取れませんでした。「写真を選ぶ」から選んでください');
    }
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      // Trusted Types：登録できるスクリプトをこの1つに固定する
      const url = window.trustedTypes
        ? window.trustedTypes.createPolicy('omoide-sw', { createScriptURL: () => 'sw.js' }).createScriptURL('')
        : 'sw.js';
      navigator.serviceWorker.register(url, { scope: './' }).catch(() => {});
    } catch (_) {}
  }

  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const STANDALONE = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  function checkSupport() {
    const c = document.createElement('canvas');
    if (window.createImageBitmap && c.getContext && c.toBlob && window.Promise) return;
    setText(el.tip, 'このブラウザでは使えません。Safari か Chrome で開いてください。');
    el.tip.hidden = false;
    el.file.disabled = true;
    for (const l of document.querySelectorAll('label[for="file"]')) l.classList.add('off');
    state.unsupported = true;
  }
  // ファイルつきの共有が本当にできるか（LINEの中のブラウザなどでは使えないことがある）
  function canShareVideo() {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File([''], 'a.mp4', { type: 'video/mp4' })] })); } catch (_) { return false; }
  }
  function showTips() {
    // LINEのアプリ内ブラウザでは共有ボタンが使えないことがある
    const ua = navigator.userAgent, inLine = /\bLine\//i.test(ua);
    if (!inLine && /Instagram|FBAN|FBAV|TikTok|musical_ly|Twitter/i.test(ua) && !CAN_SHARE) {
      setText(el.tip, 'アプリ内のブラウザで開いています。動画をそのまま送るには、メニューから「ブラウザで開く」を選んでください。');
      el.tip.hidden = false;
    }
    if (inLine && !canShareVideo()) {
      // 最初の画面：写真を選ぶ前に、ふつうのブラウザへ移ってもらう
      const kanaOn = new URLSearchParams(location.search).has('kana');
      $('open-out').href = `${location.pathname}?openExternalBrowser=1${kanaOn ? '&kana=1' : ''}`;
      $('line-card').hidden = false;
      document.body.classList.add('in-line');
      const a = document.createElement('a');
      a.href = $('open-out').href;
      setText(a, 'ブラウザで開きなおす');
      delete el.tip.dataset.raw;
      el.tip.replaceChildren('LINEのブラウザで開いています。動画をそのまま送るには　', a);
      el.tip.hidden = el.player.hidden; // 最初の画面は下のカードが案内する
    }
  }
  // 1本つくり終えた人にだけ、次回もっと楽になる方法を伝える
  function showInstallTip() {
    if (!IS_ANDROID || STANDALONE || !('serviceWorker' in navigator) || !el.tip.hidden) return;
    setText(el.tip, '次からもっと早く：このページを「ホーム画面に追加」すると、LINEで写真を選んで「共有」するだけで作れます。');
    el.tip.hidden = false;
  }

  // ---------- イベント ----------
  el.file.addEventListener('change', () => addFiles(el.file.files));
  // キーボードでも「写真を選ぶ」「写真を追加」を押せるように
  for (const l of document.querySelectorAll('label[for="file"]')) {
    l.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !el.file.disabled) { e.preventDefault(); el.file.click(); } });
  }
  $('load-cancel').addEventListener('click', () => { state.cancelLoad = true; });
  for (const zone of document.querySelectorAll('.stack, .steps')) zone.addEventListener('click', () => { if (!el.file.disabled) el.file.click(); });
  // 画面のどこに落としても受け取る（ブラウザがファイルを開いてしまうのも防ぐ）
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  // 最初のタップで音を出す許可をもらっておく（写真をえらんだ直後に自動再生するため）
  const unlock = () => { const ac = ensureAudio(); if (ac && ac.state !== 'running') { const p = ac.resume(); if (p && p.catch) p.catch(() => {}); } };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  $('undo-btn').addEventListener('click', doUndo);
  el.sortTime.addEventListener('click', () => { clearUndo(); state.manualOrder = false; sortByTime(); photosChanged(); });

  // やり直す：押しまちがいで写真が消えないよう、2回目のタップで実行する
  // はじめにもどる：その場の2回押しではなく、離れた場所の「消して もどる」で実行（連打で消えない）
  function askReset(show) {
    $('confirm').hidden = !show;
    $('confirm').closest('.dock').classList.toggle('asking', show);
    if (show) setPanel(false);
    el.clear.disabled = show || state.exporting || state.loading;
    layout();
    if (show) $('confirm-no').focus({ preventScroll: true });
  }
  el.clear.addEventListener('click', () => { if (!state.exporting) { if (state.playing) pause(); askReset(true); } });
  $('confirm-no').addEventListener('click', () => askReset(false));
  $('confirm-yes').addEventListener('click', () => {
    askReset(false);
    stop();
    clearUndo();
    for (const p of state.photos) dropCache(p.id);
    state.photos = []; state.manualOrder = false; state.saidLong = false;
    clearErrors();
    hint('');
    el.title.value = ''; $('title-clear').hidden = true;
    choice.track = choice.aspect = choice.dur = 'auto'; choice.fit = 'fill'; choice.filter = 'none';
    lastStrip = null;
    setPanel(false);
    photosChanged();
  });

  // 押した手ごたえ（対応端末のみ・ごく短い振動）
  const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} };

  function setPanel(open) {
    el.panel.hidden = !open;
    document.body.classList.toggle('editing', open);
    el.adjust.setAttribute('aria-expanded', String(open));
    syncEditButton();
    el.bigPlay.hidden = state.playing || !state.photos.length || open;
    if (open) { closeResult(); showNowInList(); syncDeco(); paintSwatches(); }
    layout();
  }
  // 編集ボタン：何が変えられるか（いまの曲）を小さく出す
  const SONG = { sunny: 'はずむ', golden: 'なつかしい', breeze: 'さわやか', night: '夜' };
  function syncEditButton() {
    const open = !el.panel.hidden;
    setText($('adjust-label'), open ? '閉じる' : '編集');
    const k = settings().track;
    setText($('adjust-sub'), open || !state.photos.length ? '' : (k ? `♪ ${SONG[k]}` : '曲なし'));
  }
  function showNowInList() {
    const li = el.thumbs.children[currentIndex()];
    if (li) el.thumbs.scrollLeft = Math.max(0, li.offsetLeft - el.thumbs.offsetLeft - 16);
  }
  // タブ：最後に開いたタブを覚えておく（開くたびに最初へ戻さない）
  function setTab(name) {
    el.panel.dataset.tab = name;
    for (const t of el.panel.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    el.panel.scrollTop = 0;
    if (name === 'photos') showNowInList();
    if (name === 'deco') { syncDeco(); paintSwatches(); }
  }
  for (const t of el.panel.querySelectorAll('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
  el.adjust.addEventListener('click', () => setPanel(el.panel.hidden));
  // シートの見出しを下に引いたら閉じる（SNSアプリと同じ作法）
  {
    const head = el.panel.querySelector('.sheet-head');
    let startY = null;
    head.addEventListener('pointerdown', (e) => { startY = e.clientY; });
    window.addEventListener('pointerup', (e) => {
      if (startY === null) return;
      const dy = e.clientY - startY;
      startY = null;
      if (dy > 50 && !el.panel.hidden) setPanel(false);
    });
  }

  // アレンジを変えたら、すぐ最初から再生して結果を見せる（同時に動画も作り直す）
  function rearranged() {
    stop(); invalidate(); hint('');
    state.pos = 0; refresh();
    play(0);
  }
  for (const c of el.chips) {
    c.addEventListener('click', () => {
      const group = c.parentElement.dataset.group;
      if (!Object.hasOwn(choice, group) || state.exporting) return;
      if (group === 'filter' && choice.filter === c.dataset.value) return;
      choice[group] = c.dataset.value;
      buzz(8);
      if (group === 'filter') { applyLook(); return; }
      rearranged();
      if (group === 'track' && c.dataset.value === 'none') hint('音のない動画になります');
    });
  }
  el.title.addEventListener('input', () => {
    stop(); invalidate(); hint('');
    state.pos = Math.min(1.2, totalTime()); // タイトルが見える位置で止めて見せる
    draw(state.pos);
    updateButtons();
  });
  el.title.addEventListener('change', rearranged);
  const syncIdeas = () => { for (const b of $('ideas').children) b.classList.toggle('on', !!b.textContent && el.title.value.includes(b.dataset.w)); };
  // タイトルの候補：押すだけで入る。日付は写真の日時から作る
  function renderIdeas() {
    const times = state.photos.map((p) => p.time).filter((t) => t > 0).sort((x, y) => x - y);
    const words = ['文化祭', '体育祭', '修学旅行', '部活', '旅行', '誕生日'];
    if (times.length) { const d = new Date(times[Math.floor(times.length / 2)]); words.unshift(`${d.getFullYear()}年${d.getMonth() + 1}月`); }
    $('ideas').replaceChildren(...words.map((w, k) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'idea'; b.dataset.w = w;
      setText(b, w);
      b.addEventListener('click', () => {
        if (state.exporting) return;
        const cur = el.title.value.trim();
        const isDate = k === 0 && times.length;
        if (cur.includes(w)) el.title.value = cur.replace(w, '').replace(/\s+/g, ' ').trim(); // もう一度押すと消える
        // 日付は今のタイトルのうしろに足す。ことばは入れかえる
        else el.title.value = (isDate && cur ? `${cur} ${w}` : (!isDate && cur && times.length && cur === words[0] ? `${w} ${cur}` : w)).slice(0, 40);
        $('title-clear').hidden = !el.title.value;
        syncIdeas();
        buzz(8);
        rearranged();
      });
      return b;
    }));
  }
  const titleClear = $('title-clear');
  const syncTitleClear = () => { titleClear.hidden = !el.title.value; };
  el.title.addEventListener('input', () => { syncTitleClear(); syncIdeas(); });
  titleClear.addEventListener('click', () => { el.title.value = ''; syncTitleClear(); rearranged(); });
  el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.title.blur(); });

  // ---------- かざりタブ ----------
  // 色あいを変えたら：一覧の写真も塗り替え、最初の2枚の準備ができてから再生（=動画も作り直す）
  async function applyLook() {
    stop(); invalidate(); hint('');
    renderThumbs();
    paintSwatches();
    state.pos = 0; refresh();
    await within(Promise.all([want(0), want(1)]), 2500);
    play(0);
  }
  // 色あいの見本：いま映っている写真で、それぞれの色あいを小さく見せる
  function paintSwatches() {
    if (el.panel.hidden || el.panel.dataset.tab !== 'deco' || el.panel.dataset.seg !== 'look') return;
    const p = state.photos[currentIndex()];
    if (!p) return;
    if (!p.thumb0) syncThumb(p);
    const src = p.thumb0 || p.thumb;
    for (const b of el.panel.querySelectorAll('.chip.look')) {
      const c = b.querySelector('canvas');
      const key = `${p.id}:${b.dataset.value}`;
      if (c.dataset.key === key) continue;
      const tmp = tintCanvas(src, src.width, src.height, lookOf(b.dataset.value));
      drawCover(c.getContext('2d'), tmp, tmp.width, tmp.height, 0, 0, c.width, c.height);
      tmp.width = tmp.height = 0;
      c.dataset.key = key;
    }
  }
  // スタンプのボタン（絵は動画と同じものを小さく描く）
  const stampBtns = STAMPS.map((s) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = s.text ? 'stamp wide' : 'stamp'; b.dataset.k = s.k;
    b.setAttribute('aria-label', s.name);
    b.setAttribute('aria-pressed', 'false');
    const spr = sprite('stamp', s.k, s.text ? 104 : 88); // 2倍で描いて半分の大きさで見せる（くっきり）
    const c = makeCanvas(spr.width, spr.height);
    c.getContext('2d').drawImage(spr, 0, 0);
    c.style.width = `${spr.width / 2}px`;
    c.setAttribute('aria-hidden', 'true');
    b.append(c);
    b.addEventListener('click', () => tapStamp(s.k));
    return b;
  });
  const stampOff = document.createElement('button');
  stampOff.type = 'button'; stampOff.className = 'stamp off';
  setText(stampOff, 'なし');
  stampOff.setAttribute('aria-label', 'スタンプを外す');
  stampOff.addEventListener('click', () => editDeco((d) => { d.stamp = null; }, 'スタンプを外しました'));
  $('stamps').replaceChildren(stampOff, ...stampBtns);
  const moveBtns = MOVES.map((m) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.k = m.k;
    setText(b, m.name);
    b.addEventListener('click', () => editDeco((d) => { d.move = m.k; }, m.k === 'none' ? '動くかざりを外しました' : `「${m.name}」を付けました`, m.k !== 'none'));
    return b;
  });
  $('moves').replaceChildren(...moveBtns);
  const SAYS = ['最高！', 'また行こう！', 'おつかれ！', 'なつかしい', 'ありがとう', 'たのしかった'];
  $('say-ideas').replaceChildren(...SAYS.map((w) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'idea'; b.dataset.w = w;
    setText(b, w);
    b.addEventListener('click', () => {
      const d = state.photos[currentIndex()] && decoOf(state.photos[currentIndex()]);
      const next = d && d.say === w ? '' : w; // もう一度押すと消える
      $('say').value = next;
      editDeco((dd) => { dd.say = next; }, next ? 'ひとことを付けました' : 'ひとことを消しました', !!next);
    });
    return b;
  }));

  // いまの写真のかざりを変える。止めてその写真を見せ、動きつきなら少しだけ再生して見せる
  let lastStrip = null; // 「全部外す」の直前の状態（元に戻す用）
  function editDeco(fn, msg, preview) {
    if (state.exporting || state.loading || !state.photos.length) return;
    const i = currentIndex(), p = state.photos[i];
    stop(); invalidate();
    fn(decoOf(p));
    buzz(8);
    const D = settings().dur;
    state.pos = i * D + 0.02;
    refresh();
    syncDeco();
    hint(msg || '');
    if (preview) play(i * D + 0.001, { until: (i + 1) * D - 0.04 });
  }
  function tapStamp(k) {
    const p = state.photos[currentIndex()];
    if (!p) return;
    const d = decoOf(p);
    if (d.stamp === k) {
      const pos = POS[(POS.indexOf(d.pos) + 1) % POS.length];
      editDeco((dd) => { dd.pos = pos; }, `${POS_NAME[pos]}に動かしました`);
    } else {
      const first = !d.stamp;
      editDeco((dd) => { dd.stamp = k; if (first) dd.pos = POS[0]; }, `${STAMP[k].name.replace(/！$/, '')}を${POS_NAME[first ? POS[0] : d.pos]}に付けました`, true);
    }
  }
  const segBtns = Array.from(el.panel.querySelectorAll('.seg-btn'));
  // タブの中の表示を、いまの写真に合わせる
  function syncDeco() {
    if (el.panel.hidden || el.panel.dataset.tab !== 'deco') return;
    const n = state.photos.length, i = currentIndex(), p = state.photos[i];
    if (!p) return;
    const d = decoOf(p);
    setText($('deco-which'), `${i + 1}/${n}枚目に付けます`);
    // 付いているものには、切りかえボタンに印を出す
    const has = { stamp: !!d.stamp, move: d.move !== 'none', say: !!d.say, look: choice.filter !== 'none' };
    for (const b of segBtns) b.classList.toggle('has', has[b.dataset.seg]);
    $('deco-prev').disabled = i === 0 || state.exporting;
    $('deco-next').disabled = i >= n - 1 || state.exporting;
    for (const b of stampBtns) b.setAttribute('aria-pressed', String(d.stamp === b.dataset.k));
    stampOff.setAttribute('aria-pressed', String(!d.stamp));
    setText($('stamp-hint'), d.stamp ? `いまは${POS_NAME[d.pos]}。同じスタンプをもう一度押すと、場所が変わります` : '押すと、この写真に付きます');
    for (const b of moveBtns) b.setAttribute('aria-pressed', String(d.move === b.dataset.k));
    if (document.activeElement !== $('say')) $('say').value = d.say;
    $('say-clear').hidden = !d.say;
    for (const b of $('say-ideas').children) b.classList.toggle('on', d.say === b.dataset.w);
    const any = state.photos.some(hasDeco);
    $('deco-off').hidden = !any && !lastStrip;
    setText($('deco-off'), lastStrip && !any ? '外したかざりを元に戻す' : 'かざりを全部外す');
    for (const b of el.panel.querySelectorAll('.stamp, #moves .chip, #say-ideas .idea, #deco-auto, #say')) b.disabled = state.exporting || state.loading;
    if (!state.playing) paintSwatches();
  }
  // かざりタブの中の切りかえ（スタンプ / 動き / ひとこと / 色あい）。小さい画面でもスクロールが少なくて済む
  function setSeg(name) {
    el.panel.dataset.seg = name;
    for (const b of segBtns) b.setAttribute('aria-selected', String(b.dataset.seg === name));
    el.panel.scrollTop = 0;
    syncDeco();
    paintSwatches(); // 再生中でも、開いたときに見本を描く
  }
  for (const b of segBtns) b.addEventListener('click', () => { buzz(6); setSeg(b.dataset.seg); });
  $('deco-prev').addEventListener('click', () => { jumpTo(currentIndex() - 1); syncDeco(); });
  $('deco-next').addEventListener('click', () => { jumpTo(currentIndex() + 1); syncDeco(); });
  const sayBox = $('say');
  sayBox.addEventListener('input', () => {
    const p = state.photos[currentIndex()];
    if (!p || state.exporting) return;
    if (state.playing) stop();
    invalidate();
    decoOf(p).say = cleanText(sayBox.value).slice(0, 16);
    state.pos = currentIndex() * settings().dur + 0.02;
    draw(state.pos);
    $('say-clear').hidden = !sayBox.value;
    for (const b of $('say-ideas').children) b.classList.toggle('on', decoOf(p).say === b.dataset.w);
    updateButtons();
  });
  sayBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') sayBox.blur(); });
  sayBox.addEventListener('change', () => { if (sayBox.value) editDeco(() => {}, '', true); });
  $('say-clear').addEventListener('click', () => { sayBox.value = ''; editDeco((d) => { d.say = ''; }, 'ひとことを消しました'); });

  // おまかせ：写真の雰囲気から、3枚に1枚くらいにスタンプ、1枚に動くかざりを付ける
  function autoDeco() {
    if (state.exporting || state.loading || !state.photos.length) return;
    let count = 0;
    const ps = state.photos;
    const pickFor = (p) => {
      const { L, S, W } = p.stats;
      const set = L < 0.3 ? ['kira', 'star', 'note', 'crown'] : W > 0.08 ? ['heart', 'flower', 'smile', 'thanks'] : S > 0.35 && L > 0.45 ? ['laugh', 'star', 'best', 'kira'] : ['smile', 'note', 'flower', 'wow'];
      return set[Math.floor(hash01(p.id * 7 + 1) * set.length)];
    };
    ps.forEach((p, i) => {
      if (hasDeco(p) || (ps.length >= 2 && i % 3 !== 1)) return;
      const d = decoOf(p);
      d.stamp = pickFor(p);
      d.pos = POS[Math.floor(hash01(p.id * 3) * 2)]; // 下の左右（顔にかぶりにくい）
      count++;
    });
    // いちばん明るく色の濃い1枚には、動くかざりも
    const best = ps.reduce((a, p) => (!a || p.stats.S + p.stats.L > a.stats.S + a.stats.L ? p : a), null);
    if (best && decoOf(best).move === 'none') { if (!hasDeco(best)) count++; decoOf(best).move = best.stats.W > 0.06 ? 'hearts' : best.stats.L < 0.35 ? 'kira' : 'petals'; }
    lastStrip = null;
    syncDeco();
    hint(`${Math.max(1, count)}枚にかざりを付けました。気に入らなければ「全部外す」で戻せます`);
    stop(); invalidate(); state.pos = 0; refresh(); play(0);
  }
  $('deco-auto').addEventListener('click', autoDeco);
  $('deco-off').addEventListener('click', () => {
    if (state.exporting) return;
    stop(); invalidate();
    if (state.photos.some(hasDeco)) {
      lastStrip = state.photos.map((p) => [p, p.deco ? { ...p.deco } : null]);
      for (const p of state.photos) p.deco = null;
      hint('かざりを全部外しました');
    } else if (lastStrip) {
      for (const [p, d] of lastStrip) if (d) p.deco = d;
      lastStrip = null;
      hint('かざりを元に戻しました');
    }
    refresh(); syncDeco();
  });

  el.play.addEventListener('click', toggle);
  el.bigPlay.addEventListener('click', toggle);
  let swipe = null, swiped = false;
  // 再生ボタンの上から始めたスワイプも拾えるよう、動画の枠全体で受ける
  el.stage.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; swiped = false; });
  // 指が動画の外まで行っても拾えるよう、離した位置は画面全体で受ける
  window.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx) || state.exporting) return;
    swiped = true; // 直後のタップ扱い（再生・停止）は無視する
    jumpTo(clamp(currentIndex() + (dx < 0 ? 1 : -1), 0, state.photos.length - 1));
  });
  window.addEventListener('pointercancel', () => { swipe = null; });
  el.stage.addEventListener('click', (e) => { if (swiped) { swiped = false; e.stopPropagation(); e.preventDefault(); } }, true);
  el.canvas.addEventListener('click', toggle);
  el.seek.addEventListener('input', () => {
    if (state.exporting) return;
    paintSeek();
    const t = (Number(el.seek.value) / 1000) * totalTime();
    if (state.playing) { stop(); play(t); }
    else {
      // 止めているときは、写真の頭にぴったり合わせる
      if (rec.paused) { abortRecording(); updateButtons(); } // 場所を動かしたら、途中の動画は作り直し
      const D = settings().dur, i = clamp(Math.round(t / D), 0, state.photos.length - 1);
      state.pos = i ? i * D + 0.02 : 0;
      draw(state.pos);
      setText(el.time, stoppedLabel());
    }
  });
  el.seek.addEventListener('change', () => { if (!state.playing && !state.exporting) syncSeek(state.pos, totalTime()); });
  for (const zone of [el.stage, el.thumbs]) zone.addEventListener('contextmenu', (e) => e.preventDefault());
  function toggleMute() {
    state.muted = !state.muted;
    if (audio.master) audio.master.gain.value = state.muted ? 0 : 1;
    const b = $('mute');
    b.setAttribute('aria-pressed', String(state.muted));
    b.setAttribute('aria-label', state.muted ? '音を出す' : '音を消す');
    hint(state.muted ? '音を消しました。作る動画には曲が入ります' : '');
  }
  $('mute').addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
  // 35 画像の貼り付け（パソコン・Chromebookでスクリーンショットなどを入れるとき）
  document.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith('image/'));
    if (files.length && !(e.target && e.target.tagName === 'INPUT')) { e.preventDefault(); addFiles(files); }
  });
  el.send.addEventListener('click', send);
  $('keep').addEventListener('click', () => { if (state.ready) download(state.ready.blob, state.ready.name, true); });
  el.recCancel.addEventListener('click', () => cancelWait());
  el.poster.addEventListener('click', makePoster);
  el.share.addEventListener('click', share);
  el.resultClose.addEventListener('click', closeResult);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (state.exporting && rec.paused && !state.playing) play(state.pos); // 待っている途中だったら、つづきから
      return;
    }
    if (state.playing) { pause(); if (!state.exporting) hint('止めました。▶ を押すと続きから見られます'); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target && e.target.tagName) && state.photos.length) {
      e.preventDefault();
      jumpTo(clamp(currentIndex() + (e.code === 'ArrowRight' ? 1 : -1), 0, state.photos.length - 1));
      return;
    }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target && e.target.tagName);
    if (!typing && e.code === 'KeyM' && state.photos.length && !$('mute').hidden) { toggleMute(); return; }
    if (!typing && (e.code === 'Delete' || e.code === 'Backspace') && !$('drop-now').hidden) { e.preventDefault(); $('drop-now').click(); return; }
    if (e.code !== 'Space' || e.repeat) return;
    const tag = e.target && e.target.tagName;
    if (['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA', 'A', 'VIDEO', 'LABEL', 'SUMMARY'].includes(tag)) return;
    e.preventDefault();
    toggle();
  });
  window.addEventListener('pagehide', closeResult);
  // 戻る操作（ジェスチャー・ボタン）では、いきなり消さずに確認を出す
  window.addEventListener('popstate', () => {
    if (!state.photos.length) return;
    try { history.pushState({ omoide: 1 }, '', location.href); } catch (_) {}
    if (state.playing) pause();
    askReset(true);
  });
  window.addEventListener('beforeunload', (e) => {
    if (!state.photos.length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  if (window.visualViewport) {
    // キーボードが出たら、その分だけ画面を縮めて並べ直す
    window.visualViewport.addEventListener('resize', () => {
      const vv = window.visualViewport;
      const shrunk = el.app.dataset.mode === 'player' && vv.height < window.innerHeight - 80;
      el.app.style.height = shrunk ? `${Math.round(vv.height)}px` : '';
      document.body.classList.toggle('typing', shrunk);
      layout();
    });
  }
  if (window.ResizeObserver) new ResizeObserver(layout).observe(el.view);
  window.addEventListener('resize', layout);
  document.getElementById('kana').addEventListener('click', () => setKana(!kana.on));
  if (new URLSearchParams(location.search).has('kana')) setKana(true);
  checkSupport();
  setPanel(false);
  refresh();
  registerWorker();
  showTips();
  takeShared();
})();
