// ==UserScript==
// @name         Enhanced Litmus View
// @namespace    http://tampermonkey.net/
// @version      0.10
// @description  Add MML/OSM/Google map layers, road-owner & cadastral overlays, distance measurement and a WGS84 DDM coordinate picker to the reviewer Litmus Test page
// @author       Veli-Pekka Eloranta
// @match        https://admin.geocaching.com/LitmusTest/*
// @require      https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
// @resource     leafletCss https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_getResourceText
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://github.com/weellu/kpRevScript/raw/main/EnhancedLitmusView.user.js
// @downloadURL  https://github.com/weellu/kpRevScript/raw/main/EnhancedLitmusView.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // MML (Maanmittauslaitos) API key — stored in Tampermonkey, not in code.
    // Set / clear it from the Tampermonkey menu. Get a personal key:
    // https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje
    // ---------------------------------------------------------------------
    const KEY_STORE = 'mml_api_key';
    const PROMPTED_STORE = 'mml_api_key_prompted';
    const FILTER_STORE = 'litmus_hidden_categories'; // persisted filter selections
    let apiKey = GM_getValue(KEY_STORE, '');

    GM_registerMenuCommand('Set MML API key', function () {
        const v = prompt('Enter your MML (Maanmittauslaitos) API key:', GM_getValue(KEY_STORE, ''));
        if (v !== null) { GM_setValue(KEY_STORE, v.trim()); GM_setValue(PROMPTED_STORE, true); location.reload(); }
    });
    GM_registerMenuCommand('Clear MML API key', function () {
        GM_deleteValue(KEY_STORE); GM_deleteValue(PROMPTED_STORE); location.reload();
    });

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function karttapaikkaLink(lat, lon) {
        return 'https://asiointi.maanmittauslaitos.fi/karttapaikka/api/linkki?x=' + lat +
            '&y=' + lon + '&srs=EPSG:4258&scale=4000';
    }
    function fmtDist(m) {
        return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
    }
    // WGS84 degrees -> DDM (degrees decimal minutes), the geocaching.com
    // format, e.g. N 65° 00.170'  E 025° 37.620'
    function toDDM(deg, isLat) {
        const hemi = deg >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
        const a = Math.abs(deg);
        let d = Math.floor(a);
        let ms = ((a - d) * 60).toFixed(3);
        if (parseFloat(ms) >= 60) { ms = '0.000'; d += 1; }   // rounding rollover
        const dp = String(d).padStart(isLat ? 2 : 3, '0');
        const parts = ms.split('.');
        return hemi + ' ' + dp + '° ' + parts[0].padStart(2, '0') + '.' + parts[1] + "'";
    }
    function fmtCoord(lat, lng) { return toDDM(lat, true) + ' ' + toDDM(lng, false); }

    // Read the cache + waypoint coordinates the Litmus page exposes as
    // [data-lat][data-lng] anchors (cache first, then waypoints).
    function readPoints() {
        const pts = [];
        document.querySelectorAll('[data-lat][data-lng]').forEach(function (a) {
            const lat = parseFloat(a.getAttribute('data-lat'));
            const lng = parseFloat(a.getAttribute('data-lng'));
            if (isNaN(lat) || isNaN(lng)) return;
            // Each anchor carries the point's own geocaching type icon.
            const img = a.querySelector('img') || (a.closest('tr,li,div') || a).querySelector('img');
            pts.push({
                lat: lat, lng: lng,
                label: (a.textContent || '').trim(),
                icon: img ? img.src : null
            });
        });
        return pts;
    }

    // The Litmus page exposes the full map data as window.LitmusTest.jsonData:
    //   ourCache (obj), ourWaypoints (array), otherCaches (obj by id),
    //   otherWaypoints (obj by id). Each point has latLng:[lat,lng] + typeID.
    const WPT_PIN = 'https://www.geocaching.com/images/wpttypes/pins/';
    function pageWin() { try { return (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window; } catch (e) { return window; } }
    function getJsonData() { try { return pageWin().LitmusTest.jsonData; } catch (e) { return null; } }

    // Find the page's Google Maps instance (bounded deep search of the app
    // object then window) so we can nudge it after un-hiding the original map.
    function findGoogleMap() {
        const w = pageWin();
        const g = w.google;
        if (!g || !g.maps || !g.maps.Map) return null;
        const seen = new Set(); let found = null, n = 0;
        function rec(o, d) {
            if (found || n > 20000 || d > 6 || !o || typeof o !== 'object' || seen.has(o)) return;
            seen.add(o); n++;
            try { if (o instanceof g.maps.Map) { found = o; return; } } catch (e) { }
            let ks; try { ks = Object.keys(o); } catch (e) { return; }
            for (let i = 0; i < ks.length; i++) {
                const k = ks[i];
                if (k === 'self' || k === 'window' || k === 'top' || k === 'parent' || k === 'frames' || k === 'document' || k === 'ownerDocument') continue;
                let v; try { v = o[k]; } catch (e) { continue; }
                if (v && typeof v === 'object' && !(typeof Node !== 'undefined' && v instanceof Node) && !(typeof Window !== 'undefined' && v instanceof Window)) rec(v, d + 1);
            }
        }
        try { rec(w.LitmusTest || {}, 0); } catch (e) { }
        if (!found) { try { rec(w, 0); } catch (e) { } }
        return found;
    }
    function validLL(p) {
        return p && Array.isArray(p.latLng) && p.latLng.length >= 2 &&
            typeof p.latLng[0] === 'number' && typeof p.latLng[1] === 'number';
    }
    // Returns { ours:[], others:[], cacheLL:[lat,lng] }.
    function collectPoints() {
        const data = getJsonData();
        const ours = [], others = [];
        if (data) {
            if (validLL(data.ourCache)) ours.push(Object.assign({ _ours: true, _isCache: true }, data.ourCache));
            if (Array.isArray(data.ourWaypoints)) data.ourWaypoints.forEach(function (p) { if (validLL(p)) ours.push(Object.assign({ _ours: true }, p)); });
            if (data.otherCaches) Object.keys(data.otherCaches).forEach(function (k) { if (validLL(data.otherCaches[k])) others.push(Object.assign({}, data.otherCaches[k])); });
            if (data.otherWaypoints) Object.keys(data.otherWaypoints).forEach(function (k) { if (validLL(data.otherWaypoints[k])) others.push(Object.assign({ _isWaypoint: true }, data.otherWaypoints[k])); });
        } else {
            // Fallback: the reviewed cache's points from the [data-lat] anchors.
            readPoints().forEach(function (p) { ours.push({ _ours: true, latLng: [p.lat, p.lng], name: p.label, _iconUrl: p.icon }); });
        }
        const cacheLL = (data && validLL(data.ourCache)) ? data.ourCache.latLng : (ours[0] ? ours[0].latLng : null);
        return { ours: ours, others: others, cacheLL: cacheLL };
    }
    function pinIcon(typeID, cls) {
        return L.icon({ iconUrl: WPT_PIN + typeID + '.png', iconSize: [20, 23], iconAnchor: [10, 23], popupAnchor: [0, -20], className: cls || '' });
    }
    const WP_TYPES = { 217: 'Parking Area', 218: 'Question to Answer', 219: 'Stages of a Multicache', 220: 'Final Location', 221: 'Trailhead', 452: 'Reference Point' };
    function googleMapsLink(lat, lng) { return 'https://www.google.com/maps?q=' + lat + ',' + lng; }
    function pointPopup(p) {
        const lat = p.latLng[0], lng = p.latLng[1];
        const isWaypoint = !!(p.parentCacheGCCode || p.refName);
        const gc = p.gcCode || p.parentCacheGCCode || '';
        const cacheName = isWaypoint ? (p.parentCacheName || 'Kätkö') : (p.name || 'Kätkö');
        const css = String(p.css || p.parentCacheCSS || '');
        const archived = /Archived/i.test(css) || !!p.isArchived || !!p.parentCacheIsArchived;
        const disabled = /Disabled/i.test(css) && !archived;
        const date = p.localizedDateCreate || p.parentCacheLocalizedDateCreate || '';

        // Cache name -> link to its listing; archived = struck through, disabled = italic.
        let name = escapeHtml(cacheName);
        if (gc) { name = '<a target="_blank" href="https://coord.info/' + encodeURIComponent(gc) + '">' + name + '</a>'; }
        if (archived) { name = '<s>' + name + '</s>'; }
        else if (disabled) { name = '<i>' + name + '</i>'; }

        let html = '<b>' + name + '</b>' + (gc ? ' <small>(' + escapeHtml(gc) + ')</small>' : '');
        if (isWaypoint) { html += '<br>' + escapeHtml(p.name || WP_TYPES[p.typeID] || 'Waypoint'); }
        html += '<br>' + fmtCoord(lat, lng);
        if (date) { html += '<br>' + escapeHtml(date); }
        html += '<br><a target="_blank" href="' + karttapaikkaLink(lat, lng) + '">Karttapaikka</a>' +
            ' · <a target="_blank" href="' + googleMapsLink(lat, lng) + '">Google Maps</a>';
        return html;
    }

    // ---------------------------------------------------------------------
    // Build the enhanced map
    // ---------------------------------------------------------------------
    function buildMap() {
        const collected = collectPoints();
        if (!collected.cacheLL) return;
        const cacheLL = collected.cacheLL;

        // Leaflet CSS (fetched by the userscript manager, CSP-safe)
        try { GM_addStyle(GM_getResourceText('leafletCss')); }
        catch (e) {
            const l = document.createElement('link');
            l.rel = 'stylesheet'; l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(l);
        }
        GM_addStyle(
            '.kp-wrap{display:flex;gap:8px;margin:10px 0;align-items:stretch;}' +
            '#kp-map{height:500px;flex:1 1 auto;min-width:0;border:1px solid #ccc;}' +
            '#kp-list{flex:0 0 280px;height:500px;overflow-y:auto;border:1px solid #ccc;background:#fff;font-size:13px;}' +
            '#kp-filters{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:4px;' +
            'padding:6px;background:#fafafa;border-bottom:1px solid #ddd;}' +
            '.kp-filter{font-size:11px;padding:2px 7px;border:1px solid #aaa;border-radius:11px;' +
            'background:#fff;cursor:pointer;color:#333;}' +
            '.kp-filter.kp-off{background:#eee;color:#aaa;text-decoration:line-through;border-color:#ccc;}' +
            '.kp-list-h{font-weight:bold;padding:5px 8px;background:#f0f0f0;border-bottom:1px solid #ddd;}' +
            '.kp-list-row{display:flex;align-items:center;gap:6px;padding:4px 8px;text-decoration:none;' +
            'color:#222;border-bottom:1px solid #f0f0f0;cursor:pointer;}' +
            '.kp-list-row:hover{background:#eef6ff;}' +
            '.kp-list-row img{width:16px;height:16px;flex:0 0 16px;object-fit:contain;}' +
            '.kp-list-row small{color:#888;}' +
            '.kp-list-row.kp-arch{opacity:0.55;}' +
            // Marker highlight tints: reviewed=gold, warning=red, archived=grey.
            '.kp-hl-gold{filter:drop-shadow(0 0 3px #f59f00) drop-shadow(0 0 3px #f59f00);}' +
            '.kp-hl-red{filter:drop-shadow(0 0 3px #e03131) drop-shadow(0 0 3px #e03131);}' +
            '.kp-hl-grey{filter:grayscale(100%) opacity(0.55);}' +
            '.kp-map-title{font-weight:bold;margin:12px 0 2px;}' +
            '.kp-orig-toggle{margin-left:10px;font-size:12px;font-weight:normal;padding:2px 8px;' +
            'cursor:pointer;border:1px solid #888;border-radius:4px;background:#f4f4f4;}' +
            '.kp-orig-toggle:hover{background:#e8e8e8;}' +
            '.leaflet-control-layers-toggle{' +
            'background-image:url(https://unpkg.com/leaflet@1.9.4/dist/images/layers.png);}' +
            '.leaflet-retina .leaflet-control-layers-toggle{' +
            'background-image:url(https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png);background-size:26px 26px;}' +
            '.kp-road-control{background:#fff;border-radius:5px;box-shadow:0 1px 5px rgba(0,0,0,0.4);}' +
            '.leaflet-touch .kp-road-control{border:2px solid rgba(0,0,0,0.2);box-shadow:none;}' +
            '.kp-road-control a{width:36px;height:36px;display:flex;align-items:center;' +
            'justify-content:center;color:#333;cursor:pointer;border-radius:5px;}' +
            '.leaflet-touch .kp-road-control a{width:44px;height:44px;}' +
            '.kp-road-control a.active{background:#4a90d9;color:#fff;}' +
            '.kp-cadastral{filter:brightness(0) saturate(100%) invert(15%) sepia(98%) ' +
            'saturate(7480%) hue-rotate(2deg) brightness(100%) contrast(118%) ' +
            'drop-shadow(0 0 0.5px #ff0000);}' +
            '.kp-measure-tip{background:#fff;border:1px solid #4dabf7;color:#0b60b0;' +
            'font-weight:bold;padding:1px 6px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.3);}' +
            '.kp-measure-tip:before{display:none;}' +
            '.kp-coordbox{background:#fff;padding:6px;border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,0.4);' +
            'display:flex;gap:6px;align-items:center;}' +
            '.kp-coord-input{width:230px;font-family:monospace;font-size:13px;padding:3px 6px;' +
            'border:1px solid #bbb;border-radius:3px;}' +
            '.kp-coord-copy{padding:3px 10px;cursor:pointer;border:1px solid #888;border-radius:3px;' +
            'background:#f4f4f4;font-size:13px;}' +
            '.kp-coord-copy:hover{background:#e8e8e8;}');

        // Insert the map after the existing proximity (Google) map, hide that
        // original map by default, and offer a button to bring it back.
        const anchor =
            document.querySelector('.ProximityMap') ||
            document.querySelector('#map_canvas') ||
            document.querySelector('#map');
        const origEls = [document.getElementById('map'), document.querySelector('.ProximityMap')].filter(Boolean);
        origEls.forEach(function (el) { el.style.display = 'none'; });

        const title = document.createElement('div');
        title.className = 'kp-map-title';
        title.appendChild(document.createTextNode('Enhanced Proximity Map by Descarted'));
        const origToggle = document.createElement('button');
        origToggle.type = 'button';
        origToggle.className = 'kp-orig-toggle';
        origToggle.textContent = 'Näytä alkuperäinen kartta';
        origToggle.addEventListener('click', function () {
            const nowHidden = origEls.length && origEls[0].style.display === 'none';
            origEls.forEach(function (el) { el.style.display = nowHidden ? '' : 'none'; });
            origToggle.textContent = nowHidden ? 'Piilota alkuperäinen kartta' : 'Näytä alkuperäinen kartta';
            if (nowHidden) {
                // Google Maps only draws one tile after being un-hidden; nudge
                // the real map instance (a 1 px pan + back = a "move") to reload.
                setTimeout(function () {
                    try {
                        const gmap = findGoogleMap();
                        const g = pageWin().google;
                        if (gmap) {
                            if (g && g.maps && g.maps.event) { g.maps.event.trigger(gmap, 'resize'); }
                            if (gmap.panBy) { gmap.panBy(1, 1); gmap.panBy(-1, -1); }
                        } else {
                            window.dispatchEvent(new Event('resize'));
                        }
                    } catch (e) { window.dispatchEvent(new Event('resize')); }
                }, 100);
            }
        });
        title.appendChild(origToggle);
        const wrap = document.createElement('div');
        wrap.className = 'kp-wrap';
        const mapDiv = document.createElement('div');
        mapDiv.id = 'kp-map';
        const listDiv = document.createElement('div');
        listDiv.id = 'kp-list';
        wrap.appendChild(mapDiv);
        wrap.appendChild(listDiv);
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(title, anchor.nextSibling);
            title.parentNode.insertBefore(wrap, title.nextSibling);
        } else {
            document.body.insertBefore(title, document.body.firstChild);
            document.body.insertBefore(wrap, title.nextSibling);
        }

        const map = L.map('kp-map');

        // --- Base layers -------------------------------------------------
        const mmlUrl = function (layer) {
            return 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/' + layer +
                '/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png?api-key=' + apiKey;
        };
        const mmlAttr = '&copy; Maanmittauslaitos';
        const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        });
        const googleLayer = function (lyrs) {
            return L.tileLayer('https://mt{s}.google.com/vt/lyrs=' + lyrs + '&x={x}&y={y}&z={z}', {
                maxZoom: 20, subdomains: '0123', attribution: '&copy; Google'
            });
        };
        const gRoads = googleLayer('m'), gSat = googleLayer('s'), gHybrid = googleLayer('y'), gTerrain = googleLayer('p');

        const baseMaps = {};
        let defaultLayer = osm;
        if (apiKey) {
            const maastokartta = L.tileLayer(mmlUrl('maastokartta'), { maxZoom: 18, attribution: mmlAttr });
            const taustakartta = L.tileLayer(mmlUrl('taustakartta'), { maxZoom: 18, attribution: mmlAttr });
            const ortokuva = L.tileLayer(mmlUrl('ortokuva'), { maxZoom: 18, attribution: mmlAttr });
            baseMaps['Maastokartta (MML)'] = maastokartta;
            baseMaps['Taustakartta (MML)'] = taustakartta;
            baseMaps['Ilmakuva (MML)'] = ortokuva;
            defaultLayer = taustakartta;
            let fellBack = false;
            [maastokartta, taustakartta, ortokuva].forEach(function (layer) {
                layer.on('tileerror', function () {
                    if (fellBack || !map.hasLayer(layer)) return;
                    fellBack = true;
                    console.warn('[EnhancedLitmus] MML tiles failed, falling back to OpenStreetMap. Check your MML API key.');
                    map.removeLayer(layer); osm.addTo(map);
                });
            });
        }
        baseMaps['OpenStreetMap'] = osm;
        baseMaps['Google Maps'] = gRoads;
        baseMaps['Google Satelliitti'] = gSat;
        baseMaps['Google Hybridi'] = gHybrid;
        baseMaps['Google Maasto'] = gTerrain;

        defaultLayer.addTo(map);
        map.setView([cacheLL[0], cacheLL[1]], 15);

        let currentBase = defaultLayer;
        map.on('baselayerchange', function (e) {
            currentBase = e.layer;
            if (map.hasLayer(roadOwners)) { roadOwners.bringToFront(); }
        });
        function setBase(layer) {
            if (currentBase && map.hasLayer(currentBase)) { map.removeLayer(currentBase); }
            layer.addTo(map);
            currentBase = layer;
            if (map.hasLayer(roadOwners)) { roadOwners.bringToFront(); }
        }

        // --- Overlays ----------------------------------------------------
        const digiroadOws = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/digiroad/ows';
        const roadOwners = L.tileLayer.wms(digiroadOws, {
            layers: 'dr_tielinkki_hall_lk', format: 'image/png', transparent: true,
            version: '1.3.0', maxZoom: 20, opacity: 0.8, attribution: '&copy; Väylävirasto, Digiroad'
        });
        const cadastral = L.tileLayer.wms('https://inspire-wms.maanmittauslaitos.fi/inspire-wms/cp/wms', {
            layers: 'CP.CadastralBoundary', format: 'image/png', transparent: true,
            version: '1.3.0', maxZoom: 20, className: 'kp-cadastral', attribution: '&copy; Maanmittauslaitos'
        });
        L.control.layers(baseMaps, {}).addTo(map);

        // Road-owner legend (shown only while the overlay is active)
        const ownerLegend = L.control({ position: 'bottomright' });
        ownerLegend.onAdd = function () {
            const div = L.DomUtil.create('div', 'kp-legend');
            div.style.background = 'rgba(255,255,255,0.85)';
            div.style.padding = '4px 6px';
            div.style.border = '1px solid #ccc';
            div.style.borderRadius = '4px';
            div.innerHTML = '<img alt="Tiestön omistajat" src="' + digiroadOws +
                '?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer=dr_tielinkki_hall_lk">';
            return div;
        };

        // --- Toggle-button factory --------------------------------------
        function iconButton(iconSvg, title, onClick) {
            const Ctl = L.Control.extend({
                options: { position: 'topright' },
                onAdd: function () {
                    const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                    const link = L.DomUtil.create('a', '', container);
                    link.href = '#';
                    link.title = title;
                    link.innerHTML = iconSvg;
                    L.DomEvent.disableClickPropagation(container);
                    L.DomEvent.on(link, 'click', function (e) { L.DomEvent.preventDefault(e); onClick(link); });
                    this._link = link;
                    return container;
                }
            });
            const inst = new Ctl();
            map.addControl(inst);
            return inst._link;
        }

        const ROAD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 3 5 21M17 3l2 18M12 4v3M12 10.5v3M12 17v3"/></svg>';
        const CAD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v18H3z"/><path d="M3 10h9M12 3v14M12 14h9"/></svg>';
        const MEASURE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2.5 21.5 9.5 9.5 21.5 2.5 14.5z"/><path d="M7 11l1.5 1.5M10 8l1.5 1.5M13 5l1.5 1.5"/></svg>';
        const COORD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';

        // --- Road-owner toggle (also switches base to Google) -----------
        let roadOwnersActive = false, preToggleBase = null;
        const roadLink = iconButton(ROAD_ICON, 'Näytä tiestön omistajat', function (link) {
            roadOwnersActive = !roadOwnersActive;
            if (roadOwnersActive) {
                preToggleBase = currentBase;
                setBase(gRoads);
                roadOwners.addTo(map); roadOwners.bringToFront(); ownerLegend.addTo(map);
                link.classList.add('active'); link.title = 'Piilota tiestön omistajat';
            } else {
                if (map.hasLayer(roadOwners)) { map.removeLayer(roadOwners); }
                map.removeControl(ownerLegend);
                if (preToggleBase) { setBase(preToggleBase); }
                link.classList.remove('active'); link.title = 'Näytä tiestön omistajat';
            }
        });

        // --- Cadastral toggle (bright-red boundaries) -------------------
        let cadastralActive = false;
        const cadLink = iconButton(CAD_ICON, 'Näytä kiinteistörajat', function (link) {
            cadastralActive = !cadastralActive;
            if (cadastralActive) {
                cadastral.addTo(map); cadastral.bringToFront();
                link.classList.add('active'); link.title = 'Piilota kiinteistörajat';
            } else {
                if (map.hasLayer(cadastral)) { map.removeLayer(cadastral); }
                link.classList.remove('active'); link.title = 'Näytä kiinteistörajat';
            }
        });

        // --- Distance measurement (two-click, snaps to known points) ----
        const measurePoints = [];
        const SNAP_PX = 20;
        let measureActive = false, measureStart = null, measureLine = null, measureTip = null, measLink = null;
        function snapLatLng(latlng) {
            const p = map.latLngToContainerPoint(latlng);
            let best = latlng, bestPx = SNAP_PX;
            measurePoints.forEach(function (kp) {
                const d = p.distanceTo(map.latLngToContainerPoint(kp));
                if (d <= bestPx) { bestPx = d; best = kp; }
            });
            return best;
        }
        function clearMeasure() {
            if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
            if (measureTip) { map.removeLayer(measureTip); measureTip = null; }
            measureStart = null;
        }
        function measureDraw(from, to, locked) {
            const dash = locked ? null : '6,6';
            if (!measureLine) {
                measureLine = L.polyline([from, to], { color: '#4dabf7', weight: 3, opacity: 0.9, dashArray: dash }).addTo(map);
            } else {
                measureLine.setLatLngs([from, to]); measureLine.setStyle({ dashArray: dash });
            }
            const content = fmtDist(map.distance(from, to));
            if (!measureTip) {
                measureTip = L.tooltip({ permanent: true, direction: 'top', offset: [0, -6], className: 'kp-measure-tip' })
                    .setLatLng(to).setContent(content);
                measureTip.addTo(map);
            } else {
                measureTip.setLatLng(to).setContent(content);
            }
        }
        function onMeasureMove(e) { if (measureStart) { measureDraw(measureStart, snapLatLng(e.latlng), false); } }
        function onMeasureClick(e) {
            const pt = snapLatLng(e.latlng);
            if (!measureStart) { measureStart = pt; return; }
            measureDraw(measureStart, pt, true);
            stopMeasureMode();
        }
        function stopMeasureMode() {
            map.off('mousemove', onMeasureMove);
            map.off('click', onMeasureClick);
            map.getContainer().style.cursor = '';
            measureActive = false;
            if (measLink) { measLink.classList.remove('active'); measLink.title = 'Mittaa etäisyys'; }
        }
        measLink = iconButton(MEASURE_ICON, 'Mittaa etäisyys', function (link) {
            if (measureActive) { stopMeasureMode(); clearMeasure(); return; }
            stopCoordMode(); clearCoord();
            clearMeasure();
            measureActive = true;
            link.classList.add('active'); link.title = 'Lopeta / nollaa mittaus';
            map.getContainer().style.cursor = 'crosshair';
            map.on('mousemove', onMeasureMove);
            map.on('click', onMeasureClick);
        });

        // --- WGS84 DDM (degrees decimal minutes) coordinate picker --------------------------------
        let coordActive = false, coordMarker = null, coordInput = null, coordBoxCtl = null, coordLink = null;
        const CoordBox = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                const div = L.DomUtil.create('div', 'kp-coordbox');
                div.innerHTML = '<input class="kp-coord-input" readonly aria-label="Koordinaatit">' +
                    '<button class="kp-coord-copy" type="button">Kopioi</button>';
                coordInput = div.querySelector('.kp-coord-input');
                const btn = div.querySelector('.kp-coord-copy');
                L.DomEvent.disableClickPropagation(div);
                L.DomEvent.on(btn, 'click', function (e) { L.DomEvent.preventDefault(e); doCopy(btn); });
                return div;
            }
        });
        function doCopy(btn) {
            const v = coordInput ? coordInput.value : '';
            if (!v) return;
            try { GM_setClipboard(v); }
            catch (e) { if (navigator.clipboard) { navigator.clipboard.writeText(v); } }
            const old = btn.textContent; btn.textContent = 'Kopioitu!';
            setTimeout(function () { btn.textContent = old; }, 1200);
        }
        function onCoordClick(e) {
            const ll = e.latlng;
            const txt = fmtCoord(ll.lat, ll.lng);
            if (!coordBoxCtl) { coordBoxCtl = new CoordBox(); map.addControl(coordBoxCtl); }
            if (coordInput) { coordInput.value = txt; }
            if (!coordMarker) {
                coordMarker = L.circleMarker(ll, { radius: 6, color: '#e03131', weight: 2, fillColor: '#e03131', fillOpacity: 0.6 }).addTo(map);
            } else { coordMarker.setLatLng(ll); }
            coordMarker.bindPopup(txt).openPopup();
        }
        function stopCoordMode() {
            map.off('click', onCoordClick);
            map.getContainer().style.cursor = '';
            coordActive = false;
            if (coordLink) { coordLink.classList.remove('active'); coordLink.title = 'Poimi koordinaatit'; }
        }
        function clearCoord() {
            if (coordBoxCtl) { map.removeControl(coordBoxCtl); coordBoxCtl = null; coordInput = null; }
            if (coordMarker) { map.removeLayer(coordMarker); coordMarker = null; }
        }
        coordLink = iconButton(COORD_ICON, 'Poimi koordinaatit', function (link) {
            if (coordActive) { stopCoordMode(); clearCoord(); return; }
            stopMeasureMode();
            coordActive = true;
            link.classList.add('active'); link.title = 'Lopeta koordinaattien poiminta';
            map.getContainer().style.cursor = 'crosshair';
            map.on('click', onCoordClick);
        });

        // A reviewed point's 161 m circle is RED only when the Litmus test
        // flags a real proximity conflict for that point (a non-PASS result).
        // resultItems already encode what matters: only the cache coordinate,
        // physical stages and finals count — virtual stages, parking, other
        // waypoint types and archived neighbours are all PASS -> green.
        function hasConflict(p) {
            const data = getJsonData();
            const items = (data && Array.isArray(data.resultItems)) ? data.resultItems : null;
            if (items) {
                return items.some(function (r) {
                    const nonPass = (typeof r.level === 'number' && r.level > 1) ||
                        (r.levelLabel && String(r.levelLabel).toUpperCase() !== 'PASS');
                    if (!nonPass) return false;
                    return p._isCache ? (r.ourCacheID === p.id && r.ourWaypointID == null) : (r.ourWaypointID === p.id);
                });
            }
            // Fallback only if resultItems is unavailable: geometric, non-archived.
            const ll = L.latLng(p.latLng[0], p.latLng[1]);
            return collected.others.some(function (o) { return !o.isArchived && ll.distanceTo(L.latLng(o.latLng[0], o.latLng[1])) <= 161; });
        }

        // Categorise a neighbour for the filter chips: archived/disabled/
        // unpublished come from its css status string (space-separated),
        // pass/warning from resultItems.levelLabel.
        function neighbourCats(p) {
            const css = String(p.css || p.parentCacheCSS || '');
            const archived = /Archived/i.test(css) || !!p.isArchived || !!p.parentCacheIsArchived;
            const disabled = /Disabled/i.test(css) && !archived;
            const unpublished = /Unpublished/i.test(css);
            const data = getJsonData();
            const items = (data && Array.isArray(data.resultItems)) ? data.resultItems : [];
            const rel = items.filter(function (r) { return p._isWaypoint ? (r.otherWaypointID === p.id) : (r.otherCacheID === p.id); });
            let warning = false;
            if (rel.length) { warning = rel.some(function (r) { return (r.level && r.level > 1) || (r.levelLabel && String(r.levelLabel).toUpperCase() !== 'PASS'); }); }
            return { archived: archived, disabled: disabled, unpublished: unpublished, pass: rel.length ? !warning : false, warning: warning };
        }

        // --- Markers -----------------------------------------------------
        const ourBounds = L.latLngBounds([]);

        function addPoint(p, isOurs) {
            const ll = L.latLng(p.latLng[0], p.latLng[1]);
            p._ll = ll;
            measurePoints.push(ll);
            if (!isOurs) { p._cats = neighbourCats(p); }

            // Highlight tint: reviewed = gold, warning (saturation) = red,
            // archived = grey, everything else normal.
            const cls = isOurs ? 'kp-hl-gold'
                : (p._cats && p._cats.warning) ? 'kp-hl-red'
                : (p._cats && p._cats.archived) ? 'kp-hl-grey' : '';

            let marker;
            if (typeof p.typeID === 'number') {
                marker = L.marker(ll, { icon: pinIcon(p.typeID, cls) });
            } else if (p._iconUrl) {
                marker = L.marker(ll, { icon: L.icon({ iconUrl: p._iconUrl, iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8], className: cls }) });
            } else {
                marker = L.circleMarker(ll, { radius: 6, color: isOurs ? '#c92a2a' : '#1971c2', weight: 2, fillOpacity: 0.85 });
            }
            marker.addTo(map).bindPopup(pointPopup(p));
            p._marker = marker;

            if (isOurs) {
                ourBounds.extend(ll);
                const colour = hasConflict(p) ? '#e03131' : '#2f9e44';
                L.circle(ll, { radius: 161, color: colour, weight: 1.5, opacity: 0.85, fill: false }).addTo(map);
            }
        }

        collected.others.forEach(function (p) { addPoint(p, false); });
        collected.ours.forEach(function (p) { addPoint(p, true); });

        // Frame the reviewed cache's points (neighbours stay pannable around).
        if (ourBounds.isValid()) { map.fitBounds(ourBounds.pad(0.8), { maxZoom: 16 }); }
        else { map.setView([cacheLL[0], cacheLL[1]], 16); }

        // --- Filter chips (hide categories) + components list ------------
        const FILTERS = [
            { key: 'archived', label: 'Arkistoidut' },
            { key: 'disabled', label: 'Hyllytetyt' },
            { key: 'unpublished', label: 'Julkaisemattomat' },
            { key: 'pass', label: 'PASS' },
            { key: 'warning', label: 'Warning' }
        ];
        // Filter selections persist across caches and refreshes.
        let stored = {};
        try { stored = GM_getValue(FILTER_STORE, {}) || {}; } catch (e) { stored = {}; }
        const hideCat = Object.assign({}, stored);
        const filterBar = document.createElement('div');
        filterBar.id = 'kp-filters';
        FILTERS.forEach(function (f) {
            const count = collected.others.filter(function (p) { return p._cats && p._cats[f.key]; }).length;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'kp-filter' + (hideCat[f.key] ? ' kp-off' : '');
            btn.textContent = f.label + ' (' + count + ')';
            btn.title = 'Piilota kartalta/listasta: ' + f.label;
            btn.addEventListener('click', function () {
                hideCat[f.key] = !hideCat[f.key];
                btn.classList.toggle('kp-off', !!hideCat[f.key]);
                try { GM_setValue(FILTER_STORE, hideCat); } catch (e) { /* ignore */ }
                applyFilters();
            });
            filterBar.appendChild(btn);
        });
        listDiv.appendChild(filterBar);

        let neighbourHeader = null;
        function listSection(titleText, pts, isNeighbours) {
            if (!pts.length) return;
            const h = document.createElement('div');
            h.className = 'kp-list-h';
            h.textContent = titleText + ' (' + pts.length + ')';
            listDiv.appendChild(h);
            if (isNeighbours) { neighbourHeader = h; }
            pts.forEach(function (p) {
                const row = document.createElement('a');
                row.className = 'kp-list-row' + (p.isArchived ? ' kp-arch' : '');
                row.href = '#';
                const iconUrl = (typeof p.typeID === 'number') ? (WPT_PIN + p.typeID + '.png') : (p._iconUrl || '');
                const gc = p.gcCode || p.parentCacheGCCode || '';
                row.innerHTML = (iconUrl ? '<img src="' + iconUrl + '">' : '') +
                    '<span>' + escapeHtml(p.name || 'Piste') + (gc ? ' <small>' + escapeHtml(gc) + '</small>' : '') + '</span>';
                row.addEventListener('click', function (e) {
                    e.preventDefault();
                    if (p._ll) {
                        map.setView(p._ll, Math.max(map.getZoom(), 16));
                        if (p._marker && p._marker.openPopup) { p._marker.openPopup(); }
                    }
                });
                listDiv.appendChild(row);
                p._listRow = row;
            });
        }
        listSection('Tarkastettava kätkö', collected.ours, false);
        listSection('Naapurit', collected.others, true);

        // Hide/show neighbours (map + list) by the active filter categories.
        function applyFilters() {
            let visible = 0;
            collected.others.forEach(function (p) {
                const hide = FILTERS.some(function (f) { return hideCat[f.key] && p._cats && p._cats[f.key]; });
                if (p._marker) {
                    if (hide && map.hasLayer(p._marker)) { map.removeLayer(p._marker); }
                    else if (!hide && !map.hasLayer(p._marker)) { map.addLayer(p._marker); }
                }
                if (p._listRow) { p._listRow.style.display = hide ? 'none' : ''; }
                if (!hide) { visible++; }
            });
            if (neighbourHeader) { neighbourHeader.textContent = 'Naapurit (' + visible + '/' + collected.others.length + ')'; }
        }
        applyFilters(); // apply any persisted selections on load

        // The map lives in a new flex layout; make sure Leaflet re-measures.
        setTimeout(function () { map.invalidateSize(); }, 0);
    }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------
    function init() {
        if (init._done) return;
        // jsonData is server-rendered but may lag slightly; retry briefly.
        if (!getJsonData() && !readPoints().length) {
            init._tries = (init._tries || 0) + 1;
            if (init._tries <= 20) { setTimeout(init, 300); }
            return;
        }
        init._done = true;
        if (!apiKey && !GM_getValue(PROMPTED_STORE, false)) {
            const v = prompt(
                'Enter your MML API key to use Karttapaikka maps.\n' +
                '(Leave empty to use OpenStreetMap. You can set it later from the Tampermonkey menu.)', '');
            GM_setValue(PROMPTED_STORE, true);
            if (v && v.trim()) { apiKey = v.trim(); GM_setValue(KEY_STORE, apiKey); }
        }
        buildMap();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
