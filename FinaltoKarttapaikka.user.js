// ==UserScript==
// @name         Final to karttapaikka + reviewer map
// @namespace    http://tampermonkey.net/
// @version      0.80
// @description  Add Kansalaisen Karttapaikka links and an interactive MML/OSM/Google map (waypoints, range rings, road-owner overlay) to the geocache review page
// @author       Veli-Pekka Eloranta
// @match        https://*.geocaching.com/*
// @require      https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
// @resource     leafletCss https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_getResourceText
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://github.com/weellu/kpRevScript/raw/main/FinaltoKarttapaikka.user.js
// @downloadURL  https://github.com/weellu/kpRevScript/raw/main/FinaltoKarttapaikka.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // MML (Maanmittauslaitos) API key handling
    //
    // The key is stored in Tampermonkey storage, NOT in this file, so it is
    // never committed to the public repo. Set / change / clear it from the
    // Tampermonkey menu (the puzzle icon -> this script).
    // Get a personal key: https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje
    // ---------------------------------------------------------------------
    const KEY_STORE = 'mml_api_key';
    const PROMPTED_STORE = 'mml_api_key_prompted';

    let apiKey = GM_getValue(KEY_STORE, '');

    GM_registerMenuCommand('Set MML API key', function () {
        const v = prompt('Enter your MML (Maanmittauslaitos) API key:', GM_getValue(KEY_STORE, ''));
        if (v !== null) {
            GM_setValue(KEY_STORE, v.trim());
            GM_setValue(PROMPTED_STORE, true);
            location.reload();
        }
    });
    GM_registerMenuCommand('Clear MML API key', function () {
        GM_deleteValue(KEY_STORE);
        GM_deleteValue(PROMPTED_STORE);
        location.reload();
    });

    // ---------------------------------------------------------------------
    // Feature 1: Karttapaikka links next to each waypoint distance
    // (works on any page that has the waypoint distance cells)
    // ---------------------------------------------------------------------
    function karttapaikkaLink(lat, lon) {
        return 'https://asiointi.maanmittauslaitos.fi/karttapaikka/api/linkki?x=' + lat +
            '&y=' + lon + '&srs=EPSG:4258&scale=4000';
    }

    function addWaypointLinks() {
        const data = document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (!data) return;

        const spans = document.querySelectorAll(
            '[id^="ctl00_ContentBody_Waypoints_Waypoints_ctl"][id$="_uxDistance"]');
        if (!spans.length) return;

        spans.forEach(function (span, i) {
            const parentTd = span.closest('td');
            if (!parentTd || parentTd.querySelector('.kp-wp-link')) return;

            const lat = data.getAttribute('data-wp_' + i + '_latitude');
            const lon = data.getAttribute('data-wp_' + i + '_longitude');
            if (!lat || !lon) return;

            const link = document.createElement('a');
            link.className = 'kp-wp-link';
            link.href = karttapaikkaLink(lat, lon);
            link.textContent = 'View on Kansalaisen Karttapaikka';
            link.target = '_blank';
            link.style.display = 'block';
            link.style.marginLeft = '10px';
            link.style.textDecoration = 'none';
            link.style.color = '#0066cc';
            parentTd.appendChild(link);
        });
    }

    // ---------------------------------------------------------------------
    // Feature 2: Interactive map on the review page
    // ---------------------------------------------------------------------
    const waypointTypes = {
        217: 'Parking Area',
        218: 'Question to Answer',
        219: 'Stages of a Multicache',
        220: 'Final Location',
        221: 'Trailhead',
        452: 'Reference Point'
    };

    function streetViewLink(lat, lon) {
        return '<a target="_blank" href="https://maps.google.com/maps?cbp=0,0,0,0,0&layer=c&ll=' +
            lat + ',' + lon + '&cbll=' + lat + ',' + lon + '&q=' + lat + ',' + lon + '">StreetView</a>';
    }

    function pinIcon(typeId) {
        return L.icon({
            iconUrl: '../images/wpttypes/pins/' + typeId + '.png',
            iconSize: [20, 23],
            iconAnchor: [10, 23],
            shadowUrl: null
        });
    }

    function buildMap() {
        const data = document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (!data) return;

        const latitude = parseFloat(data.getAttribute('data-latitude'));
        const longitude = parseFloat(data.getAttribute('data-longitude'));
        if (isNaN(latitude) || isNaN(longitude)) return;

        const waypointCount = parseInt(data.getAttribute('data-wp_count'), 10) || 0;
        const cacheTypeId = data.getAttribute('data-cachetypeid');

        // Inject Leaflet CSS (fetched by the userscript manager, so CSP-safe)
        try {
            GM_addStyle(GM_getResourceText('leafletCss'));
        } catch (e) {
            const l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(l);
        }
        GM_addStyle(
            '#kp-map{height:400px;margin:10px 0;border:1px solid #ccc;}' +
            // Leaflet's CSS points the layers-control icon at a relative image
            // path that 404s when injected into the review page, leaving a blank
            // white button. Point it at the absolute CDN images instead.
            '.leaflet-control-layers-toggle{' +
            'background-image:url(https://unpkg.com/leaflet@1.9.4/dist/images/layers.png);}' +
            '.leaflet-retina .leaflet-control-layers-toggle{' +
            'background-image:url(https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png);background-size:26px 26px;}' +
            '.kp-legend{background:rgba(255,255,255,0.85);padding:4px 6px;border:1px solid #ccc;border-radius:4px;}' +
            '.kp-legend img{display:block;}' +
            // Match the layer-control's size in both normal and Leaflet's
            // "touch" mode (where Leaflet scales its own controls 36->44px).
            '.kp-road-control{background:#fff;border-radius:5px;box-shadow:0 1px 5px rgba(0,0,0,0.4);}' +
            '.leaflet-touch .kp-road-control{border:2px solid rgba(0,0,0,0.2);box-shadow:none;}' +
            '.kp-road-control a{width:36px;height:36px;display:flex;align-items:center;' +
            'justify-content:center;color:#333;cursor:pointer;border-radius:5px;}' +
            '.leaflet-touch .kp-road-control a{width:44px;height:44px;}' +
            '.kp-road-control a.active{background:#4a90d9;color:#fff;}');

        // Insert the map container in a sensible place on the review page
        const mapDiv = document.createElement('div');
        mapDiv.id = 'kp-map';
        const anchor =
            document.querySelector('#ctl00_ContentBody_CacheDetails_AdditionalDetails') ||
            document.querySelector('#ctl00_ContentBody_uxWaypoints') ||
            document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(mapDiv, anchor);
        } else {
            document.body.insertBefore(mapDiv, document.body.firstChild);
        }

        const map = L.map('kp-map');

        // --- Base layers -------------------------------------------------
        const mmlUrl = function (layer) {
            return 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/' + layer +
                '/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png?api-key=' + apiKey;
        };
        const mmlAttr = '&copy; Maanmittauslaitos';

        const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors'
        });

        const googleLayer = function (lyrs) {
            return L.tileLayer('https://mt{s}.google.com/vt/lyrs=' + lyrs + '&x={x}&y={y}&z={z}', {
                maxZoom: 20,
                subdomains: '0123',
                attribution: '&copy; Google'
            });
        };
        const gRoads   = googleLayer('m');
        const gSat     = googleLayer('s');
        const gHybrid  = googleLayer('y');
        const gTerrain = googleLayer('p');

        const baseMaps = {};
        let defaultLayer = osm;

        if (apiKey) {
            const maastokartta = L.tileLayer(mmlUrl('maastokartta'), { maxZoom: 18, attribution: mmlAttr });
            const taustakartta = L.tileLayer(mmlUrl('taustakartta'), { maxZoom: 18, attribution: mmlAttr });
            const ortokuva     = L.tileLayer(mmlUrl('ortokuva'),     { maxZoom: 18, attribution: mmlAttr });

            baseMaps['Maastokartta (MML)'] = maastokartta;
            baseMaps['Taustakartta (MML)'] = taustakartta;
            baseMaps['Ilmakuva (MML)'] = ortokuva;
            defaultLayer = maastokartta;

            // Automatic fallback to OSM if the MML tiles fail (bad/expired key,
            // referrer restriction, service down, ...)
            let fellBack = false;
            [maastokartta, taustakartta, ortokuva].forEach(function (layer) {
                layer.on('tileerror', function () {
                    if (fellBack || !map.hasLayer(layer)) return;
                    fellBack = true;
                    console.warn('[kpRevScript] MML tiles failed to load, falling back to OpenStreetMap. Check your MML API key.');
                    map.removeLayer(layer);
                    osm.addTo(map);
                });
            });
        }
        baseMaps['OpenStreetMap'] = osm;
        baseMaps['Google Maps'] = gRoads;
        baseMaps['Google Satelliitti'] = gSat;
        baseMaps['Google Hybridi'] = gHybrid;
        baseMaps['Google Maasto'] = gTerrain;

        defaultLayer.addTo(map);
        map.setView([latitude, longitude], 15);

        // Track the active base layer so the road-owner toggle can restore it.
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

        // --- Overlay: range rings ----------------------------------------
        const rangeLayer = L.layerGroup();

        // --- Overlay: road owners (Väylävirasto Digiroad, open WMS) ------
        // "Tiestön omistajat" = hallinnollinen luokka: valtio / kunta /
        // yksityinen. NB: the capabilities name (DR_Tielinkki_...) errors on
        // GetMap; the renderable layer is the lowercase dr_tielinkki_hall_lk.
        // Only drawn when zoomed in (server MaxScaleDenominator = 1:100000).
        const digiroadOws = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/digiroad/ows';
        const roadOwners = L.tileLayer.wms(digiroadOws, {
            layers: 'dr_tielinkki_hall_lk',
            format: 'image/png',
            transparent: true,
            version: '1.3.0',
            maxZoom: 20,
            opacity: 0.8,
            attribution: '&copy; Väylävirasto, Digiroad'
        });

        // --- Overlay: cadastral boundaries (MML INSPIRE, open, no key) ---
        // "Kiinteistörajat" — same boundaries shown in Kansalaisen
        // Karttapaikka. Keyless WMS, works on any base map. Server only draws
        // them when zoomed in (MaxScaleDenominator = 1:20000, ~zoom 15+).
        const cadastral = L.tileLayer.wms('https://inspire-wms.maanmittauslaitos.fi/inspire-wms/cp/wms', {
            layers: 'CP.CadastralBoundary',
            format: 'image/png',
            transparent: true,
            version: '1.3.0',
            maxZoom: 20,
            attribution: '&copy; Maanmittauslaitos'
        });

        const overlayMaps = {
            'Etäisyysrenkaat': rangeLayer,
            'Kiinteistörajat': cadastral
        };
        L.control.layers(baseMaps, overlayMaps).addTo(map);

        // Legend for the road-owner overlay, shown only while it is active.
        const ownerLegend = L.control({ position: 'bottomleft' });
        ownerLegend.onAdd = function () {
            const div = L.DomUtil.create('div', 'kp-legend');
            div.innerHTML = '<img alt="Tiestön omistajat" src="' + digiroadOws +
                '?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer=dr_tielinkki_hall_lk">';
            return div;
        };

        // --- Road-owner toggle control (below the layer selector) --------
        // A Leaflet control in the same top-right corner as the layer
        // switcher: pressing it forces Google Maps as the base (roads are
        // clearest there), shows the road-owner overlay + its legend, and
        // remembers the previous base. Pressing again hides the overlay and
        // restores whatever base was active before.
        // Road icon (inline SVG, uses currentColor so it inverts when active).
        const ROAD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<path d="M7 3 5 21M17 3l2 18M12 4v3M12 10.5v3M12 17v3"/></svg>';

        let roadOwnersActive = false;
        let preToggleBase = null;
        let roadLink = null;

        function toggleRoadOwners() {
            roadOwnersActive = !roadOwnersActive;
            if (roadOwnersActive) {
                preToggleBase = currentBase;
                setBase(gRoads);
                roadOwners.addTo(map);
                roadOwners.bringToFront();
                ownerLegend.addTo(map);
                if (roadLink) {
                    roadLink.title = 'Piilota tiestön omistajat';
                    roadLink.classList.add('active');
                }
            } else {
                if (map.hasLayer(roadOwners)) { map.removeLayer(roadOwners); }
                map.removeControl(ownerLegend);
                if (preToggleBase) { setBase(preToggleBase); }
                if (roadLink) {
                    roadLink.title = 'Näytä tiestön omistajat';
                    roadLink.classList.remove('active');
                }
            }
        }

        const RoadControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                roadLink = L.DomUtil.create('a', '', container);
                roadLink.href = '#';
                roadLink.title = 'Näytä tiestön omistajat';
                roadLink.setAttribute('aria-label', 'Tiestön omistajat');
                roadLink.innerHTML = ROAD_ICON;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(roadLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    toggleRoadOwners();
                });
                return container;
            }
        });
        map.addControl(new RoadControl());

        function addRange(latlng) {
            for (let r = 1; r <= 161; r += 10) {
                const circle = L.circle(latlng, {
                    radius: r,
                    color: 'red',
                    fill: false,
                    weight: 1,
                    opacity: 0.5
                });
                circle.bindPopup(r + ' metriä nollapisteestä');
                rangeLayer.addLayer(circle);
            }
        }

        // --- Cache marker ------------------------------------------------
        const bounds = L.latLngBounds([[latitude, longitude]]);

        const cacheMarker = L.marker([latitude, longitude], { icon: pinIcon(cacheTypeId) }).addTo(map);
        cacheMarker.bindPopup(
            'Latitude: ' + latitude + '<br/>Longitude: ' + longitude +
            '<br/><a target="_blank" href="' + karttapaikkaLink(latitude, longitude) + '">Karttapaikka</a>' +
            '<br/>' + streetViewLink(latitude, longitude));
        addRange([latitude, longitude]);

        // --- Waypoint markers --------------------------------------------
        for (let i = 0; i < waypointCount; i++) {
            const wpLat = parseFloat(data.getAttribute('data-wp_' + i + '_latitude'));
            const wpLon = parseFloat(data.getAttribute('data-wp_' + i + '_longitude'));
            if (isNaN(wpLat) || isNaN(wpLon)) continue;

            const wpTypeId = data.getAttribute('data-wp_' + i + '_type');
            const wpType = waypointTypes[wpTypeId] || 'Waypoint';

            const wpMarker = L.marker([wpLat, wpLon], { icon: pinIcon(wpTypeId) }).addTo(map);
            wpMarker.bindPopup(
                wpType + '<br/>Latitude: ' + wpLat + '<br/>Longitude: ' + wpLon +
                '<br/><a target="_blank" href="' + karttapaikkaLink(wpLat, wpLon) + '">Karttapaikka</a>' +
                '<br/>' + streetViewLink(wpLat, wpLon));
            addRange([wpLat, wpLon]);
            bounds.extend([wpLat, wpLon]);
        }

        if (waypointCount > 0) {
            map.fitBounds(bounds.pad(0.2));
        }
    }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------
    function init() {
        addWaypointLinks();

        const onReviewPage = /\/admin\/review\.aspx/i.test(location.pathname);
        const hasCacheData = document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (!onReviewPage || !hasCacheData) return;

        // Offer to store a key once, if we don't have one yet.
        if (!apiKey && !GM_getValue(PROMPTED_STORE, false)) {
            const v = prompt(
                'Enter your MML API key to use Karttapaikka maps.\n' +
                '(Leave empty to use OpenStreetMap. You can set it later from the Tampermonkey menu.)', '');
            GM_setValue(PROMPTED_STORE, true);
            if (v && v.trim()) {
                apiKey = v.trim();
                GM_setValue(KEY_STORE, apiKey);
            }
        }

        buildMap();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
