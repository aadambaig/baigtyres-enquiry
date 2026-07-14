/* Baig Tyres — shared site JS */
(function(){
  var rm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PAGE = document.body.dataset.page || 'home';

  /* ---------- Reveal animations ---------- */
  var io = new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target);} });
  },{threshold:0.12});
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });

  /* ---------- Backgrounds ---------- */
  var bgA = document.getElementById('bgA');
  var bgB = document.getElementById('bgB');
  if (bgA) {
    var bgImages = [];
    try { bgImages = JSON.parse(document.body.dataset.bgs || '[]'); } catch(e){}
    if (bgImages.length === 1) {
      bgA.style.backgroundImage = 'url("' + bgImages[0] + '")';
      bgA.classList.add('on');
    } else if (bgImages.length > 1 && bgB) {
      bgImages.forEach(function(src){ var img = new Image(); img.src = src; });
      bgA.style.backgroundImage = 'url("' + bgImages[0] + '")';
      bgA.classList.add('on');
      var bgLayers = [bgA, bgB], activeBg = 0, activeLayer = 0;
      var setBg = function(index){
        if(index === activeBg || !bgImages[index]) return;
        activeBg = index;
        activeLayer = 1 - activeLayer;
        var next = bgLayers[activeLayer], prev = bgLayers[1 - activeLayer];
        next.style.backgroundImage = 'url("' + bgImages[index] + '")';
        next.classList.add('on');
        prev.classList.remove('on');
      };
      var bgIo = new IntersectionObserver(function(es){
        var visible = es.filter(function(e){return e.isIntersecting;})
          .sort(function(a,b){return b.intersectionRatio-a.intersectionRatio;})[0];
        if(visible) setBg(Number(visible.target.dataset.bgIndex || 0));
      },{threshold:[0.25,0.45,0.65]});
      document.querySelectorAll('.bg-step').forEach(function(el){ bgIo.observe(el); });
    }
    if(!rm){
      var ticking=false;
      window.addEventListener('scroll',function(){
        if(!ticking){ requestAnimationFrame(function(){
          var y = 'translateY('+(window.scrollY*0.12)+'px)';
          bgA.style.transform = y;
          if (bgB) bgB.style.transform = y;
          ticking=false;
        }); ticking=true; }
      },{passive:true});
    }
  }

  /* ---------- Validation helpers ---------- */
  function ukPlateValid(p){
    var s = p.replace(/\s+/g,'').toUpperCase();
    return /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(s) ||
           /^[A-Z][0-9]{1,3}[A-Z]{3}$/.test(s) ||
           /^[A-Z]{3}[0-9]{1,3}[A-Z]?$/.test(s);
  }
  function emailValid(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  // UK mobile numbers only (the field is labelled "Mobile number") — normalise +44/0044
  // prefixes to a leading 0, then require exactly 07 followed by 9 digits (11 digits total).
  // This rejects typos, landlines and obviously fake strings like "1111111" that the old
  // loose "7-20 chars of digits/punctuation" check let straight through.
  function phoneValid(v){
    var d = String(v || '').replace(/[^\d+]/g, '').replace(/^\+44/, '0').replace(/^0044/, '0');
    return /^07\d{9}$/.test(d);
  }

  /* ---------- Vehicle lookup ---------- */
  var reg = document.getElementById('reg');
  var lookupBtn = document.getElementById('lookupBtn');
  var vehCard = document.getElementById('vehCard');
  var vehInner = document.getElementById('vehInner');
  var vehTick = document.getElementById('vehTick');
  var vehTitle = document.getElementById('vehTitle');
  var vehGrid = document.getElementById('vehGrid');
  var confirmedVehicle = null;
  var confirmedReg = '';

  if (reg) {
    reg.addEventListener('input',function(){
      reg.value = reg.value.toUpperCase().replace(/[^A-Z0-9 ]/g,'');
      if (reg.value.replace(/\s+/g,'') !== confirmedReg) { confirmedVehicle = null; }
    });
    reg.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); doLookup(); }});
  }
  if (lookupBtn) lookupBtn.addEventListener('click', doLookup);

  function doLookup(){
    if (!reg) return Promise.resolve(false);
    var plate = reg.value.trim();
    if(!ukPlateValid(plate)){
      showVeh(false, 'Check the registration', [{k:'Format',v:"That doesn't look like a UK plate"}]);
      return Promise.resolve(false);
    }
    if (lookupBtn){ lookupBtn.disabled = true; lookupBtn.textContent = 'Checking…'; }
    return fetch('/api/vehicle-lookup',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({registration:plate.replace(/\s+/g,'')})
    }).then(function(res){
      if(!res.ok) throw new Error('lookup unavailable');
      return res.json();
    }).then(function(d){
      confirmedVehicle = d;
      confirmedReg = plate.replace(/\s+/g,'').toUpperCase();
      var title = [d.make, d.model, d.colour].filter(Boolean).join(' ') || 'Vehicle found';
      var cells = [
        {k:'Make', v:d.make || '—'},
        {k:'Year', v:d.year || '—'},
        {k:'Fuel', v:d.fuel || '—'},
        {k:'Colour', v:d.colour || '—'}
      ];
      if (d.taxStatus) cells.push({k:'Tax', v:d.taxStatus, cls: String(d.taxStatus).toLowerCase()==='taxed' ? 'tax-ok':'tax-no'});
      if (d.motStatus) cells.push({k:'MOT', v:d.motStatus, cls: /valid|pass/i.test(String(d.motStatus)) ? 'tax-ok':'tax-no'});
      if (d.engine) cells.push({k:'Engine', v:d.engine + 'cc'});
      showVeh(true, title, cells);
      return true;
    }).catch(function(){
      confirmedVehicle = null;
      confirmedReg = plate.replace(/\s+/g,'').toUpperCase();
      showVeh(true, plate.toUpperCase() + ' — noted', [
        {k:'Reg', v:plate.toUpperCase()},
        {k:'Status', v:"We'll confirm your car when we call"}
      ]);
      return true;
    }).finally(function(){
      if (lookupBtn){ lookupBtn.disabled=false; lookupBtn.textContent='Confirm car →'; }
    });
  }

  function showVeh(ok, title, cells){
    if (!vehCard) return;
    vehInner.classList.toggle('err', !ok);
    vehTick.textContent = ok ? '✓' : '!';
    vehTitle.textContent = title;
    vehGrid.replaceChildren();
    cells.forEach(function(c){
      var cell = document.createElement('div');
      cell.className = 'veh-cell';
      var key = document.createElement('div'); key.className = 'k'; key.textContent = c.k;
      var val = document.createElement('div'); val.className = 'v' + (c.cls ? ' ' + c.cls : ''); val.textContent = c.v;
      cell.append(key, val);
      vehGrid.appendChild(cell);
    });
    vehCard.classList.add('show');
  }

  /* ---------- Service option pills + chips ---------- */
  var selected = new Map();
  var chips = document.getElementById('selectedChips');

  document.querySelectorAll('.acc-head').forEach(function(h){
    function toggleAcc(){
      var item = h.closest('.acc-item');
      var wasOpen = item.classList.contains('open');
      document.querySelectorAll('.acc-item').forEach(function(i){ i.classList.remove('open'); });
      document.querySelectorAll('.acc-head').forEach(function(head){ head.setAttribute('aria-expanded','false'); });
      if(!wasOpen){ item.classList.add('open'); h.setAttribute('aria-expanded','true'); }
    }
    h.addEventListener('click', toggleAcc);
    h.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleAcc(); }
    });
  });

  document.querySelectorAll('.opt').forEach(function(o){
    o.addEventListener('click',function(){
      var val = o.dataset.val.replace(/&amp;/g,'&');
      if(selected.has(val)){ selected.delete(val); o.classList.remove('sel'); }
      else { selected.set(val, true); o.classList.add('sel'); }
      renderChips();
    });
  });

  function renderChips(){
    if (!chips) return;
    chips.innerHTML='';
    selected.forEach(function(_, val){
      var el=document.createElement('span');
      el.className='sc';
      el.appendChild(document.createTextNode(val+' '));
      var btn=document.createElement('button');
      btn.type='button'; btn.setAttribute('aria-label','Remove'); btn.textContent='×';
      btn.addEventListener('click',function(){
        selected.delete(val);
        document.querySelectorAll('.opt').forEach(function(o){ if(o.dataset.val.replace(/&amp;/g,'&')===val) o.classList.remove('sel'); });
        renderChips();
      });
      el.appendChild(btn);
      chips.appendChild(el);
    });
  }

  /* ---------- Maxton carousel: one image at a time, auto-rotate every 3s with a sliding
     transition + low-contrast light sweep, still swipeable by hand, Instagram-style dots.
     Transition is rAF-driven (not native scrollTo smooth-scroll) so start/end are exact —
     that precision is what fixed a stall bug where a native-scroll-event timing guess
     occasionally mistook the tail of our own animation for a manual swipe. ---------- */
  document.querySelectorAll('.mx-carousel').forEach(function(car){
    var track = car.querySelector('.mx-track');
    var dotsWrap = car.querySelector('.mx-dots');
    var sweepEl = car.querySelector('.mx-sweep');
    if (!track) return;
    var realImgs = Array.prototype.slice.call(track.querySelectorAll('img'));
    var count = realImgs.length;
    if (count < 2) return;

    // Clone the first slide onto the end. Advancing off the last real image slides
    // forward onto this clone (identical to image 1), then we silently snap back to the
    // real first slide — so the loop reads as one continuous forward rotation.
    var clone = realImgs[0].cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('data-clone', '1');
    clone.removeAttribute('id');
    track.appendChild(clone);
    var slides = Array.prototype.slice.call(track.querySelectorAll('img'));

    var index = 0;                 // current slide index into slides[] (count == the clone)
    var userInteracting = false;
    var programmatic = false;      // true only while OUR OWN rAF-driven animation is running
    var resumeTimer = null, autoTimer = null, scrollRaf = null, settleTimer = null, animId = null;

    var dots = [];
    if (dotsWrap) {
      for (var i = 0; i < count; i++) {
        (function(i){
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'mx-dot' + (i === 0 ? ' active' : '');
          dot.setAttribute('aria-label', 'Go to image ' + (i + 1) + ' of ' + count);
          dot.addEventListener('click', function(){ pauseAuto(); goTo(i); });
          dotsWrap.appendChild(dot);
          dots.push(dot);
        })(i);
      }
    }

    function slideLeft(i){ return slides[i].offsetLeft - track.offsetLeft; }
    function closestSlideIndex(){
      var center = track.scrollLeft + track.clientWidth / 2;
      var closest = 0, cd = Infinity;
      slides.forEach(function(s, i){
        var c = (s.offsetLeft - track.offsetLeft) + s.offsetWidth / 2;
        var d = Math.abs(c - center);
        if (d < cd) { cd = d; closest = i; }
      });
      return closest;
    }
    function setActiveDot(logical){
      var l = logical % count;
      dots.forEach(function(d, di){ d.classList.toggle('active', di === l); });
    }

    function animateTo(target, done){
      if (animId) cancelAnimationFrame(animId);
      var start = track.scrollLeft;
      var change = target - start;
      if (rm || Math.abs(change) < 1) { track.scrollLeft = target; if (done) done(); return; }
      var duration = 420, t0 = null;
      function step(ts){
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / duration);
        var eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        track.scrollLeft = start + change * eased;
        if (p < 1) { animId = requestAnimationFrame(step); }
        else { animId = null; track.scrollLeft = target; if (done) done(); }
      }
      animId = requestAnimationFrame(step);
    }
    function playSweep(){
      if (!sweepEl) return;
      sweepEl.classList.remove('play');
      void sweepEl.offsetWidth;   // force reflow so the animation restarts every time
      sweepEl.classList.add('play');
    }
    function goTo(i){
      index = i;
      programmatic = true;
      setActiveDot(i % count);
      if (!rm) playSweep();
      animateTo(slideLeft(i), function(){
        if (index >= count) {
          // Landed on the clone — snap invisibly back to the real first slide.
          track.scrollLeft = slideLeft(0);
          index = 0;
          setActiveDot(0);
        }
        // Deterministic end of OUR animation: safe to hand control back to native scroll.
        requestAnimationFrame(function(){ programmatic = false; });
      });
    }
    function next(){ goTo(index + 1); }
    function pauseAuto(){
      userInteracting = true;
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(function(){ userInteracting = false; }, 4500);
    }
    function startAuto(){ stopAuto(); autoTimer = setInterval(function(){ if (!userInteracting) next(); }, 3000); }
    function stopAuto(){ if (autoTimer) clearInterval(autoTimer); }

    // Native 'scroll' events fire both from our own rAF-driven animateTo() AND from a real
    // user swipe. While `programmatic` is true, that scroll is entirely ours — ignore it
    // completely (goTo already set the dot). Only a genuine user-driven scroll
    // (programmatic === false) should pause auto-rotate or need clone-swipe handling.
    track.addEventListener('scroll', function(){
      if (programmatic) return;
      pauseAuto();
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(function(){
        scrollRaf = null;
        var closest = closestSlideIndex();
        index = closest % count;
        setActiveDot(index);
        if (closest === count) {
          // A manual swipe landed on the trailing clone — once it's truly idle, hop back invisibly.
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(function(){
            if (!programmatic && closestSlideIndex() === count) {
              track.scrollLeft = slideLeft(0);
              index = 0;
              setActiveDot(0);
            }
          }, 150);
        }
      });
    }, { passive: true });

    track.addEventListener('touchstart', pauseAuto, { passive: true });
    track.addEventListener('mouseenter', function(){ userInteracting = true; });
    track.addEventListener('mouseleave', function(){
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(function(){ userInteracting = false; }, 1500);
    });

    if (!rm) startAuto();
  });

  /* ---------- Reference photo upload (enquiry forms) — up to 5 photos ---------- */
  var MAX_IMAGES = 5;
  // Vercel serverless functions hard-cap the whole request body at 4.5MB — a platform limit,
  // not something we can raise from here. This budget (raw bytes, pre-base64) is kept well
  // under that so 5 compressed photos + the rest of the form fields always fit; the server
  // in api/enquire.js enforces MAX_TOTAL_IMAGE_BASE64_CHARS (4,200,000 base64 chars ≈
  // 3,150,000 raw bytes) independently so a bypassed/hacked client can't blow past it either
  // — kept a little under that raw-byte equivalent here so the client never offers what the
  // server would then have to silently trim.
  var TOTAL_RAW_BUDGET = 3000000; // ~2.86MB raw across all photos combined
  var pendingImages = []; // [{ data: 'data:image/jpeg;base64,...', name: 'photo.jpg' }, ...]
  var fileInput = document.getElementById('refPhoto');
  var fileDrop = document.getElementById('fileDrop');
  var fileDropLabel = document.getElementById('fileDropLabel');
  var fileThumbs = document.getElementById('fileThumbs');
  var fileErr = document.getElementById('fileErr');

  function approxRawBytes(dataUrl){
    var comma = dataUrl.indexOf(',');
    return Math.round((dataUrl.length - comma - 1) * 0.75);
  }
  function totalPendingRawBytes(){
    var total = 0;
    for (var i = 0; i < pendingImages.length; i++) total += approxRawBytes(pendingImages[i].data);
    return total;
  }
  function showFileErr(msg){
    if (!fileErr) return;
    if (!msg) { fileErr.classList.remove('show'); fileErr.textContent = ''; return; }
    fileErr.textContent = msg;
    fileErr.classList.add('show');
  }
  function renderThumbs(){
    if (!fileThumbs) return;
    fileThumbs.innerHTML = '';
    pendingImages.forEach(function(img, idx){
      var cell = document.createElement('div');
      cell.className = 'file-thumb';
      var im = document.createElement('img');
      im.src = img.data;
      im.alt = img.name || ('Reference photo ' + (idx + 1));
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-thumb-remove';
      btn.setAttribute('aria-label', 'Remove this photo');
      btn.textContent = '×';
      btn.addEventListener('click', function(e){
        e.preventDefault();
        pendingImages.splice(idx, 1);
        showFileErr('');
        renderThumbs();
        updateDropState();
      });
      cell.appendChild(im);
      cell.appendChild(btn);
      fileThumbs.appendChild(cell);
    });
  }
  function updateDropState(){
    var full = pendingImages.length >= MAX_IMAGES;
    if (fileDrop) fileDrop.classList.toggle('disabled', full);
    if (fileInput) fileInput.disabled = full;
    if (fileDropLabel) {
      fileDropLabel.textContent = full
        ? 'Max 5 photos added'
        : (pendingImages.length ? 'Add another photo (' + pendingImages.length + '/5)' : 'Add a photo (up to 5)');
    }
  }
  function resetFileField(){
    pendingImages = [];
    if (fileInput) fileInput.value = '';
    showFileErr('');
    renderThumbs();
    updateDropState();
  }
  // Compress/resize client-side so uploads stay small and email-friendly. Tries decreasing
  // JPEG quality until the result fits TARGET_RAW, falling back to the smallest it manages —
  // five full-quality phone photos would blow well past the 4.5MB request-body ceiling above.
  function compressImage(img, cb){
    var MAX_DIM = 1200;
    var w = img.width, h = img.height;
    if (Math.max(w, h) > MAX_DIM) {
      var scale = MAX_DIM / Math.max(w, h);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    var TARGET_RAW = 400000; // ~390KB raw per photo — keeps 5 photos safely inside TOTAL_RAW_BUDGET
    var qualities = [0.74, 0.6, 0.48, 0.38, 0.3];
    var dataUrl = null;
    for (var i = 0; i < qualities.length; i++) {
      var attempt;
      try { attempt = canvas.toDataURL('image/jpeg', qualities[i]); } catch (e) { attempt = null; }
      if (!attempt) break;
      dataUrl = attempt;
      if (approxRawBytes(dataUrl) <= TARGET_RAW) break;
    }
    cb(dataUrl);
  }

  if (fileInput) {
    fileInput.addEventListener('change', function(){
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = ''; // always clear so re-picking the same file later still fires 'change'
      if (!files.length) return;
      showFileErr('');

      var slotsLeft = MAX_IMAGES - pendingImages.length;
      if (slotsLeft <= 0) { showFileErr('You can attach up to 5 photos.'); return; }
      if (files.length > slotsLeft) {
        showFileErr('Only ' + slotsLeft + ' more photo' + (slotsLeft === 1 ? '' : 's') + ' fit — the rest were skipped.');
        files = files.slice(0, slotsLeft);
      }

      files.forEach(function(file){
        if (!/^image\//.test(file.type)) { showFileErr("One of those wasn't an image — skipped it."); return; }
        var reader = new FileReader();
        reader.onload = function(){
          var img = new Image();
          img.onload = function(){
            compressImage(img, function(dataUrl){
              if (!dataUrl) { showFileErr("Couldn't process one of those photos — try a different one."); return; }
              if (pendingImages.length >= MAX_IMAGES) { showFileErr('You can attach up to 5 photos.'); return; }
              if (totalPendingRawBytes() + approxRawBytes(dataUrl) > TOTAL_RAW_BUDGET) {
                showFileErr('That photo would make the enquiry too large to send — remove one first or try a smaller photo.');
                return;
              }
              pendingImages.push({ data: dataUrl, name: (file.name || 'photo.jpg').slice(0, 80) });
              renderThumbs();
              updateDropState();
            });
          };
          img.onerror = function(){ showFileErr("Couldn't read one of those photos — try a different one."); };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    });
  }
  updateDropState();

  /* ---------- Enquiry form ---------- */
  var form=document.getElementById('enquiryForm');
  if (form) {
    var resultBox=document.getElementById('result');
    var submitBtn=document.getElementById('submitBtn');
    var baseService = document.body.dataset.service || '';
    var phoneInput = document.getElementById('phone');
    var phoneErr = document.getElementById('phoneErr');

    // Live check as soon as the customer leaves the mobile field, so a bad number is
    // flagged before they get all the way to Submit — not after.
    function checkPhoneLive(){
      if (!phoneInput) return true;
      var v = phoneInput.value.trim();
      var ok = !v || phoneValid(v); // don't shame an empty field until submit
      phoneInput.classList.toggle('invalid', !ok);
      if (phoneErr) phoneErr.classList.toggle('show', !ok);
      return ok;
    }
    if (phoneInput) {
      phoneInput.addEventListener('blur', checkPhoneLive);
      phoneInput.addEventListener('input', function(){
        if (phoneInput.classList.contains('invalid')) checkPhoneLive();
      });
    }

    form.addEventListener('submit', function(e){
      e.preventDefault();
      var firstName=document.getElementById('firstName').value.trim();
      var lastName=document.getElementById('lastName').value.trim();
      var phone=document.getElementById('phone').value.trim();
      var email=document.getElementById('email').value.trim();
      var registration=(reg ? reg.value : '').trim().toUpperCase();
      var services=Array.from(selected.keys());
      if (baseService && services.indexOf(baseService) === -1) services.unshift(baseService);

      if(!firstName||!lastName){ showResult('Add your first and last name so we know who to ask for.',false); return; }
      if(!phone){ showResult('Add your mobile number so we can call or WhatsApp you back.',false); phoneInput&&phoneInput.focus(); return; }
      if(!phoneValid(phone)){
        checkPhoneLive();
        showResult('That mobile number isn\'t valid — enter a UK mobile like 07911 123456.',false);
        phoneInput&&phoneInput.focus();
        return;
      }
      if(!email||!emailValid(email)){ showResult('Check your email address so we can reach you.',false); return; }
      if(!registration||!ukPlateValid(registration)){ showResult('Add your vehicle registration — we use it to check exact parts and fitment for your car.',false); return; }
      if(services.length===0){ showResult('Pick at least one service above so we know what to call about.',false); return; }

      submitBtn.disabled=true; submitBtn.textContent='Sending…';

      var proceed = function(){
        return fetch('/api/enquire',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            firstName: firstName, lastName: lastName, phone: phone, email: email,
            registration: registration.replace(/\s+/g,''),
            vehicle: confirmedVehicle,
            services: services,
            message: document.getElementById('message').value.trim(),
            marketing_optin: document.getElementById('marketingOptin').checked,
            company: document.getElementById('company').value,
            source: 'enquiry_form',
            page: PAGE,
            images: pendingImages
          })
        }).then(function(res){
          if(!res.ok) throw new Error();
          showResult("Got it — we'll call or WhatsApp you back within one working day.",true);
          form.reset(); selected.clear(); renderChips(); resetFileField();
          if (phoneInput) phoneInput.classList.remove('invalid');
          if (phoneErr) phoneErr.classList.remove('show');
          document.querySelectorAll('.opt').forEach(function(o){ o.classList.remove('sel'); });
        }).catch(function(){
          showResult("That didn't send — call us on 01905 731396 or try again in a moment.",false);
        }).finally(function(){
          submitBtn.disabled=false; submitBtn.textContent='Submit enquiry';
        });
      };

      // If the reg hasn't been confirmed yet, look it up first so the enquiry carries verified vehicle details.
      if (registration.replace(/\s+/g,'') !== confirmedReg) { doLookup().then(proceed); }
      else { proceed(); }
    });
    function showResult(m,ok){ resultBox.textContent=m; resultBox.className='result show '+(ok?'ok':'err'); }
  }

  /* ---------- 10% offer: entry modal + sticky top tab ---------- */
  var veil=document.getElementById('modalVeil');
  var OPTIN='baigtyres_optin_v3';           // permanent once claimed
  var DISM='baigtyres_dismiss_v3';          // this visit only

  function optedIn(){ try{return localStorage.getItem(OPTIN);}catch(e){return null;} }
  function markOptin(){ try{localStorage.setItem(OPTIN,'1');}catch(e){} }
  function dismissed(){ try{return sessionStorage.getItem(DISM);}catch(e){return null;} }
  function markDismiss(){ try{sessionStorage.setItem(DISM,'1');}catch(e){} }
  function openModal(){ if (veil) veil.classList.add('show'); }
  function closeModal(){ if (veil) veil.classList.remove('show'); }
  function hideTab(){ document.body.classList.remove('has-tab'); }

  if (!optedIn()) {
    document.body.classList.add('has-tab');
    if (!dismissed()) setTimeout(openModal, 1400);
  }

  var modalX = document.getElementById('modalX');
  var modalSkip = document.getElementById('modalSkip');
  if (modalX) modalX.addEventListener('click',function(){ markDismiss(); closeModal(); });
  if (modalSkip) modalSkip.addEventListener('click',function(){ markDismiss(); closeModal(); });
  if (veil) veil.addEventListener('click',function(e){ if(e.target===veil){ markDismiss(); closeModal(); } });

  function submitOptin(contact){
    if(!contact) return Promise.resolve();
    var isEmail = contact.indexOf('@') !== -1;
    return fetch('/api/enquire',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ firstName:'', lastName:'', phone:isEmail ? '' : contact, email: isEmail ? contact : '',
        registration:'', services:[], message:'', marketing_optin:true, company:'', source:'optin_popup', page: PAGE })
    }).catch(function(){});
  }

  var modalGo = document.getElementById('modalGo');
  if (modalGo) modalGo.addEventListener('click', function(){
    var c=document.getElementById('modalContact').value.trim();
    if(!c) return;
    modalGo.disabled = true;
    submitOptin(c).then(function(){
      document.getElementById('modalForm').style.display='none';
      document.getElementById('modalDone').style.display='block';
      markOptin(); hideTab();
      setTimeout(closeModal, 3600);
    });
  });

  // The tab has no close button by design: the offer stays quietly at the top until claimed.
  var tabBtn = document.getElementById('saveTabBtn');
  if (tabBtn) tabBtn.addEventListener('click', openModal);
})();
