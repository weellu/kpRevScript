// ==UserScript==
// @name         Final to karttapaikka + reviewer map
// @namespace    http://tampermonkey.net/
// @version      0.94
// @description  Add Kansalaisen Karttapaikka links and an interactive MML/OSM/Google map (waypoints, range rings, road-owner overlay, swine fever zones, coordinate search) to the geocache review page
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

    // ---------------------------------------------------------------------
    // Feature 3: African swine fever zones (afrikkalainen sikarutto, ASF)
    //
    // One infected zone (tartuntavyohyke) with a stricter core (ydinalue)
    // inside it. The zones are published as PDF only -- there is no geodata
    // service -- so these rings are rebuilt from the decisions of 1.9.2026 and
    // 10.9.2026 (dnro 5763/04.01.02.00.02/2026). The 10.9 decision changed only
    // the restrictions (items 7, 8 and 18); the zone wording is word-for-word
    // the same, so the rings below are unchanged:
    //
    //   * ydinalue -- unchanged since 14.8.2026. Bounded in the west/north by
    //     Keipintie, Vaalimaantie, Mattilantie, Vaalimaanvayla, seututie 387
    //     and Tohmonmaentie, in the east by the national border and in the
    //     south by the sea. Traced from those OSM ways.
    //   * tartuntavyohyke -- Virolahti, Miehikkala, Kotka, Hamina and Pyhtaa in
    //     full, plus the part of Lappeenranta south of the railway to
    //     Vainikkala, plus the parts of Loviisa, Lapinjarvi and Kouvola south
    //     of the line running from the sea up the Koskenkylanjoki to the E18,
    //     then vt6 to Elimaki, mt354 to Inkeroinen and the railway to the Kotka
    //     border. Municipality borders and the railway from OSM; the western
    //     cut line comes from the map annex, whose zone polygons are vector
    //     paths (georeferenced against the known Virolahti/Miehikkala/
    //     Lappeenranta part at IoU 0.995, so the line is the official one).
    //
    // The 1.9.2026 decision dropped the short-lived split into areas A and B
    // and named those five municipalities "kokonaan"; the map annex on the site
    // is still the 28.8.2026 one, which draws the zone on land only. The rings
    // here follow the decision text and include the sea. The 10.9.2026 decision
    // settles that this is right: it lifts the dog rules specifically on "the
    // zone's sea areas and the islands and skerries in them", which only makes
    // sense if those waters are inside the zone to begin with.
    //
    // Not official geodata: confirm from the annex before deciding, and rebuild
    // these rings whenever the decision changes.
    //
    // Ring coordinates are [lon, lat].
    // ---------------------------------------------------------------------
    const ASF_UPDATED = '10.9.2026';
    const ASF_INFO_URL = 'https://www.ruokavirasto.fi/elaimet/elainten-terveys-ja-elaintaudit/' +
        'elaintaudit/siat/afrikkalainen-sikarutto/asf-suomessa-2026/';
    const ASF_MAP_URL = 'https://www.ruokavirasto.fi/globalassets/elaimet/' +
        'elainten-terveys-ja-elaintaudit/elaintaudit/asf/asf_kartta_vyohykeajab1_kunnat2.pdf';

    const ASF_ZONES = {
        ydinalue: [
            [27.87352,60.6046],[27.84795,60.5824],[27.84775,60.58179],[27.84216,60.5817],[27.84212,60.5801],[27.84101,60.57986],
            [27.84007,60.57929],[27.84003,60.57884],[27.83844,60.57846],[27.83857,60.57773],[27.84087,60.57733],[27.84203,60.57662],
            [27.84167,60.56308],[27.83559,60.56016],[27.8211,60.5567],[27.81389,60.55675],[27.81265,60.55498],[27.80171,60.54973],
            [27.79931,60.54974],[27.79567,60.54799],[27.79564,60.54681],[27.79199,60.54505],[27.78239,60.54511],[27.77883,60.54691],
            [27.77415,60.55166],[27.7742,60.55403],[27.77183,60.55522],[27.77214,60.56823],[27.76742,60.5718],[27.76748,60.57417],
            [27.76513,60.57654],[27.75801,60.58013],[27.75803,60.58131],[27.75727,60.5817],[27.7511,60.5817],[27.75108,60.5826],
            [27.75007,60.58387],[27.75028,60.58425],[27.7477,60.58658],[27.74472,60.58837],[27.74463,60.58973],[27.74806,60.59051],
            [27.74739,60.59212],[27.74586,60.59355],[27.74618,60.5951],[27.75033,60.59769],[27.7527,60.59868],[27.75416,60.60288],
            [27.75596,60.60476],[27.75586,60.60569],[27.76642,60.60718],[27.77364,60.60884],[27.7837,60.61165],[27.7913,60.61285],
            [27.79765,60.61306],[27.80384,60.61258],[27.81018,60.61159],[27.81643,60.61007],[27.81681,60.61137],[27.82374,60.61302],
            [27.8273,60.6144],[27.82984,60.61594],[27.83146,60.61745],[27.83261,60.6194],[27.83341,60.62235],[27.83505,60.62433],
            [27.83672,60.62552],[27.84337,60.62906],[27.84921,60.63278],[27.85519,60.63542],[27.86014,60.63665],[27.87156,60.63752],
            [27.87437,60.6382],[27.87657,60.63931],[27.87838,60.64097],[27.88029,60.64431],[27.88805,60.64896],[27.8894,60.65042],
            [27.88958,60.6519],[27.88549,60.65684],[27.88573,60.65791],[27.88826,60.66054],[27.89298,60.66004],[27.89515,60.65897],
            [27.89617,60.6576],[27.89821,60.65687],[27.90391,60.65691],[27.90495,60.65513],[27.90386,60.65408],[27.90402,60.65355],
            [27.90852,60.65082],[27.91227,60.64932],[27.91245,60.64852],[27.91327,60.64737],[27.91776,60.64614],[27.93004,60.63545],
            [27.87352,60.6046]
        ],
        tartuntavyohyke: [
            [26.45242,60.47782],[26.45253,60.47172],[26.44651,60.46171],[26.45622,60.45232],[26.45825,60.43152],[26.44049,60.41979],
            [26.41739,60.42552],[26.41937,60.40888],[26.43403,60.40423],[26.44327,60.38873],[26.46917,60.38163],[26.50013,60.37259],
            [26.54005,60.36219],[26.53582,60.3447],[26.50219,60.34791],[26.47683,60.35835],[26.44717,60.35685],[26.42741,60.3662],
            [26.40458,60.35861],[26.39005,60.35687],[26.38811,60.37101],[26.38958,60.3824],[26.41152,60.37778],[26.42552,60.37784],
            [26.42997,60.38008],[26.40496,60.39911],[26.39254,60.40405],[26.37848,60.40593],[26.35395,60.39832],[26.3468,60.39163],
            [26.34808,60.38359],[26.3276,60.371],[26.31016,60.37452],[26.29469,60.39025],[26.28925,60.40853],[26.27937,60.42401],
            [26.256,60.43998],[26.23657,60.45998],[26.23272,60.45122],[26.24566,60.42577],[26.25058,60.40721],[26.2615,60.39562],
            [26.24311,60.3908],[26.22389,60.39762],[26.19452,60.40605],[26.18031,60.41345],[26.16756,60.40755],[26.19759,60.39525],
            [26.19904,60.38194],[26.18938,60.36468],[26.15538,60.37973],[26.16143,60.38448],[26.16735,60.39395],[26.13426,60.3943],
            [26.1303,60.39566],[26.11804,60.40699],[26.1169,60.40389],[26.07232,60.43355],[26.06205,60.42932],[26.05971,60.42306],
            [26.06591,60.41242],[26.03647,60.4308],[26.02748,60.44059],[26.00893,60.45044],[26.00385,60.46052],[25.9963,60.46865],
            [25.96975,60.48191],[25.94046,60.49208],[25.96326,60.49143],[25.96357,60.49357],[25.9628,60.49356],[25.96495,60.50399],
            [25.96128,60.51539],[25.9729,60.52731],[25.99217,60.53358],[26.01849,60.53949],[26.03038,60.54366],[26.04988,60.55685],
            [26.06575,60.56676],[26.07375,60.57722],[26.08181,60.58544],[26.10106,60.59414],[26.11293,60.60014],[26.14289,60.61257],
            [26.18801,60.61775],[26.22436,60.62531],[26.24199,60.65276],[26.25314,60.67404],[26.28595,60.69462],[26.33641,60.70998],
            [26.38291,60.71673],[26.41855,60.72668],[26.44213,60.71209],[26.48381,60.70981],[26.52399,60.69568],[26.6331,60.68939],
            [26.69547,60.69363],[26.75793,60.68845],[26.78621,60.69094],[26.8187,60.68487],[26.82762,60.68652],[26.83101,60.68634],
            [26.84327,60.69496],[26.84683,60.68969],[26.84926,60.68512],[26.85494,60.67978],[26.864,60.67584],[26.86883,60.67002],
            [26.87537,60.66129],[26.87965,60.65075],[26.88654,60.63731],[26.92655,60.6503],[26.94364,60.65405],[26.94353,60.6555],
            [26.98504,60.66457],[27.04175,60.6793],[27.04282,60.6792],[27.04322,60.67881],[27.04415,60.67561],[27.0455,60.67448],
            [27.05302,60.67201],[27.05739,60.67246],[27.0604,60.67385],[27.06123,60.67494],[27.0636,60.67562],[27.06435,60.6754],
            [27.06518,60.67417],[27.0662,60.67391],[27.06694,60.67302],[27.06829,60.67312],[27.07025,60.6727],[27.07135,60.67309],
            [27.07298,60.67303],[27.07436,60.6724],[27.08042,60.67406],[27.10529,60.68946],[27.11013,60.69822],[27.11908,60.71246],
            [27.12971,60.71699],[27.1272,60.72011],[27.12628,60.71996],[27.12563,60.72048],[27.12386,60.72389],[27.1231,60.72459],
            [27.12328,60.725],[27.11356,60.73711],[27.11257,60.73746],[27.11061,60.7398],[27.11115,60.74055],[27.1152,60.74139],
            [27.11622,60.74194],[27.11708,60.74293],[27.11883,60.74352],[27.11936,60.74408],[27.12065,60.74413],[27.12252,60.74474],
            [27.12528,60.74619],[27.12385,60.74922],[27.12475,60.75188],[27.1239,60.75233],[27.12418,60.7527],[27.12511,60.75293],
            [27.12636,60.75666],[27.12307,60.75782],[27.1221,60.75904],[27.1207,60.7595],[27.12087,60.76022],[27.12066,60.76055],
            [27.11913,60.76156],[27.11794,60.76176],[27.11688,60.76264],[27.11712,60.76298],[27.11851,60.76321],[27.11759,60.76452],
            [27.11852,60.76427],[27.11951,60.76495],[27.12073,60.76484],[27.1241,60.77738],[27.12722,60.77657],[27.13281,60.77573],
            [27.13303,60.7764],[27.20397,60.76052],[27.21841,60.76095],[27.2272,60.76469],[27.22764,60.76585],[27.22989,60.76669],
            [27.23009,60.7672],[27.22964,60.76778],[27.23081,60.76909],[27.2307,60.76954],[27.23194,60.77012],[27.23262,60.77186],
            [27.2318,60.77277],[27.23035,60.77342],[27.23118,60.7751],[27.23202,60.77547],[27.23536,60.77584],[27.23585,60.77667],
            [27.24521,60.77666],[27.24557,60.77695],[27.24826,60.77736],[27.25264,60.77681],[27.25515,60.77803],[27.25947,60.77843],
            [27.26468,60.78064],[27.26477,60.79174],[27.26555,60.79356],[27.26516,60.79444],[27.26148,60.7949],[27.26216,60.79699],
            [27.26002,60.79872],[27.26134,60.80089],[27.26978,60.80346],[27.28377,60.81611],[27.28574,60.81611],[27.29266,60.82202],
            [27.30216,60.82098],[27.31012,60.82058],[27.32493,60.81834],[27.34803,60.82816],[27.35838,60.82972],[27.35651,60.83077],
            [27.35446,60.83104],[27.35919,60.83194],[27.3597,60.83212],[27.36015,60.83299],[27.37108,60.8361],[27.37789,60.83848],
            [27.38033,60.83873],[27.38524,60.84013],[27.41121,60.84137],[27.42837,60.84262],[27.45282,60.8206],[27.48637,60.807],
            [27.50473,60.79922],[27.54962,60.79785],[27.57828,60.80261],[27.58823,60.80392],[27.60089,60.80446],[27.6061,60.80586],
            [27.62723,60.80478],[27.65287,60.80265],[27.66423,60.80121],[27.67825,60.80165],[27.68575,60.80035],[27.68985,60.79906],
            [27.70326,60.79598],[27.71384,60.79533],[27.71574,60.79637],[27.7186,60.80021],[27.72116,60.79942],[27.72133,60.79982],
            [27.72006,60.80068],[27.71895,60.80079],[27.71894,60.81181],[27.71866,60.81461],[27.71738,60.81751],[27.72005,60.81791],
            [27.72127,60.81744],[27.72183,60.81679],[27.72352,60.81698],[27.7248,60.81672],[27.75071,60.81627],[27.74572,60.81975],
            [27.74649,60.82929],[27.7437,60.83164],[27.76688,60.83374],[27.76707,60.83333],[27.7651,60.82947],[27.75999,60.82555],
            [27.76076,60.82422],[27.80849,60.82313],[27.81206,60.82184],[27.81576,60.8219],[27.84558,60.82471],[27.83688,60.82932],
            [27.84692,60.83548],[27.87622,60.84859],[27.8638,60.85464],[27.86455,60.85483],[27.85766,60.85856],[27.8574,60.85828],
            [27.85497,60.86002],[27.87172,60.87532],[27.88338,60.87811],[27.89475,60.88687],[27.89969,60.87564],[27.90117,60.87372],
            [27.88342,60.86535],[27.88467,60.86433],[27.885,60.86341],[27.88606,60.8623],[27.8889,60.85153],[27.89476,60.84885],
            [27.89328,60.84792],[27.89351,60.84754],[27.89515,60.84742],[27.89627,60.84793],[27.9011,60.84779],[27.90457,60.85014],
            [27.90534,60.85322],[27.90435,60.85579],[27.91158,60.85803],[27.92665,60.87042],[27.93175,60.87578],[27.93321,60.87932],
            [27.93126,60.87968],[27.93198,60.88416],[27.91534,60.8866],[27.90347,60.89087],[27.90111,60.89107],[27.89134,60.90885],
            [27.8945,60.91604],[27.90248,60.92783],[27.90201,60.92885],[27.90152,60.93254],[27.90475,60.93202],[27.90889,60.93186],
            [27.91595,60.93202],[27.92915,60.93303],[27.93968,60.93297],[27.94527,60.93218],[27.9538,60.93013],[27.9795,60.9263],
            [27.98469,60.9258],[27.99627,60.92543],[28.00682,60.92699],[28.01228,60.92692],[28.02125,60.92569],[28.04231,60.92104],
            [28.06088,60.91791],[28.07773,60.91455],[28.09127,60.91278],[28.12476,60.91119],[28.12796,60.91064],[28.13578,60.90851],
            [28.14149,60.90756],[28.15152,60.90728],[28.16721,60.91045],[28.1699,60.91067],[28.17311,60.91042],[28.18388,60.90728],
            [28.18803,60.90573],[28.20695,60.8963],[28.22151,60.88736],[28.22669,60.88513],[28.2401,60.88138],[28.25071,60.87783],
            [28.25798,60.87586],[28.26643,60.87406],[28.29426,60.8657],[28.30782,60.86287],[28.33778,60.85529],[28.33565,60.85414],
            [28.33482,60.85498],[28.33216,60.85553],[28.33072,60.85623],[28.32771,60.8561],[28.32509,60.85769],[28.32423,60.85791],
            [28.31191,60.84127],[28.25584,60.80995],[28.22049,60.78279],[28.17428,60.77862],[28.13546,60.74087],[28.08899,60.7206],
            [28.03804,60.69403],[28.01517,60.68244],[28.01783,60.68118],[27.99808,60.67041],[27.99537,60.67121],[27.87343,60.60455],
            [27.84795,60.5824],[27.84775,60.58179],[27.84461,60.58074],[27.84373,60.5799],[27.84136,60.58005],[27.84007,60.57929],
            [27.84003,60.57884],[27.83844,60.57846],[27.83857,60.57773],[27.84087,60.57733],[27.84466,60.57487],[27.84405,60.5725],
            [27.8422,60.56936],[27.84174,60.56909],[27.84291,60.56705],[27.84208,60.56618],[27.8439,60.56321],[27.8454,60.56221],
            [27.84739,60.56144],[27.8144,60.55427],[27.79666,60.54564],[27.77441,60.53358],[27.77663,60.50768],[27.76831,60.50387],
            [27.76488,60.49548],[27.76819,60.48906],[27.75649,60.47177],[27.74825,60.46922],[27.74795,60.45117],[27.69439,60.43757],
            [27.68692,60.43357],[27.72577,60.39168],[27.50471,60.25465],[27.45665,60.22326],[27.29304,60.2002],[26.76464,60.20018],
            [26.74152,60.18924],[26.65615,60.17126],[26.64474,60.18919],[26.58044,60.27979],[26.57953,60.28726],[26.552,60.36715],
            [26.47131,60.40104],[26.48865,60.42425],[26.47749,60.4555],[26.45679,60.48376],[26.45242,60.47782]
        ]
    };

    // Precomputed bounding boxes, so the usual (non-Finnish-SE) cache is
    // rejected with four comparisons instead of a full ray cast.
    const ASF_BBOX = {};
    Object.keys(ASF_ZONES).forEach(function (key) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        ASF_ZONES[key].forEach(function (c) {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
        });
        ASF_BBOX[key] = [minX, minY, maxX, maxY];
    });

    function inBBox(lat, lon, bbox, pad) {
        const p = pad || 0;
        return lon >= bbox[0] - p && lon <= bbox[2] + p &&
               lat >= bbox[1] - p && lat <= bbox[3] + p;
    }

    // Ray casting; the rings are small enough that plain WGS84 degrees are
    // accurate to well under a metre here.
    function pointInRing(lat, lon, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > lat) !== (yj > lat) &&
                lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Returns 'ydinalue', 'tartuntavyohyke' or null. Strictest first, since the
    // core zone lies inside the infected zone.
    const ASF_ORDER = ['ydinalue', 'tartuntavyohyke'];

    function asfZoneAt(lat, lon) {
        for (const key of ASF_ORDER) {
            if (inBBox(lat, lon, ASF_BBOX[key]) && pointInRing(lat, lon, ASF_ZONES[key])) {
                return key;
            }
        }
        return null;
    }

    // What each zone is called and what it forbids, per the 10.9.2026 decision.
    // Dogs tightened again relative to 1.9: across the whole zone they must now
    // be leashed or immediately leashable, and hounds may not be loose at all.
    // Moving about on foot is still unrestricted outside the core zone, and the
    // dog rules are explicitly lifted on the zone's sea areas and islands.
    const ASF_INFO = {
        ydinalue: {
            css: 'kp-asf-core',
            head: '\u26d4 SIKARUTON YDINALUE \u2013 tiukimmat rajoitukset',
            name: 'ydinalue',
            rules: ['<b>Maastossa liikkuminen jalan tai ajoneuvolla muutoin kuin teit\u00e4 ' +
                    'pitkin on kielletty.</b>',
                    'Koirien ulkoiluttaminen muutoin kuin teit\u00e4 pitkin kytkettyn\u00e4 on ' +
                    'kielletty, lukuun ottamatta aidattuja koirametsi\u00e4.',
                    'Sienestys ja marjastus on kielletty.',
                    'Mets\u00e4taloustyöt ja koneellinen maanmuokkaus on kielletty.',
                    'Yleis\u00f6-, urheilu- ja koiratapahtumien j\u00e4rjest\u00e4minen on ' +
                    'kielletty koosta riippumatta.']
        },
        tartuntavyohyke: {
            css: 'kp-asf-zone',
            head: '\u26a0 SIKARUTON TARTUNTAVY\u00d6HYKE',
            name: 'tartuntavy\u00f6hyke',
            rules: ['<b>Koirat on pidett\u00e4v\u00e4 kytkettyin\u00e4 tai v\u00e4litt\u00f6m' +
                    '\u00e4sti kytkett\u00e4viss\u00e4.</b> Riistaa ajavia, haukkumalla ilmaisevia ' +
                    'ja pys\u00e4ytt\u00e4vi\u00e4 koiria ei saa pit\u00e4\u00e4 irrallaan ' +
                    'lainkaan, ei my\u00f6sk\u00e4\u00e4n koulutuksessa.',
                    'Maastossa j\u00e4rjestett\u00e4v\u00e4t koiratapahtumat on kielletty, ellei ' +
                    'koiria pidet\u00e4 kytkettyn\u00e4 ja osallistujia ole enint\u00e4\u00e4n sata.',
                    'Maastossa j\u00e4rjestett\u00e4v\u00e4t yleis\u00f6- ja urheilutapahtumat on ' +
                    'kielletty, jos osallistujia on yli sata.',
                    'Maaston kulottaminen on kielletty.',
                    'Mets\u00e4stys on kielletty; poikkeuksina ydinalueen ulkopuolella pienpetojen ' +
                    'loukku- ja rautapyynti, valkoposkihanhien suojamets\u00e4stys, hirvien ' +
                    'vahtimismets\u00e4stys pelloilla sek\u00e4 merimetsot ja hylkeet.',
                    '<b>Maastossa liikkumista jalan ei ole rajoitettu ydinalueen ulkopuolella.</b> ' +
                    'Koirarajoitukset eiv\u00e4t my\u00f6sk\u00e4\u00e4n koske vy\u00f6hykkeen ' +
                    'merialueita eiv\u00e4tk\u00e4 niill\u00e4 sijaitsevia saaria ja luotoja.']
        }
    };

    function asfLatLngs(ring) {
        return ring.map(function (c) { return [c[1], c[0]]; });
    }

    // ---------------------------------------------------------------------
    // Feature 4: coordinate search box
    //
    // Coordinates get pasted in from all over the place, so the parser is
    // deliberately forgiving. It accepts, with or without degree/minute/second
    // symbols and with the hemisphere letter on either side of its numbers:
    //   N 60° 36.000 E 027° 48.600     (geocaching's usual DDM)
    //   60 36.000 N 27 48.600 E
    //   N 60° 36' 00" E 27° 48' 36"    (DMS)
    //   60.6000, 27.8100               (decimal degrees)
    //   60,6000 27,8100                (Finnish decimal comma)
    // ---------------------------------------------------------------------
    function parseCoords(input) {
        if (!input) return null;
        let s = String(input).toUpperCase();
        s = s.replace(/[°º*'’′"”″]/g, ' ').replace(/[;|]/g, ' ');

        // A comma is either the lat/lon separator or a Finnish decimal point.
        // One comma in the whole string can only be the separator; two or more
        // must be decimal points ("60,6 27,8").
        const commas = (s.match(/,/g) || []).length;
        s = s.replace(/,/g, (/[NSEW]/.test(s) || commas === 1) ? ' ' : '.');

        const tokens = s.match(/[NSEW]|[-+]?\d+(?:\.\d+)?/g);
        if (!tokens) return null;

        // Split into groups of numbers, each optionally tagged with the
        // hemisphere letter that precedes or follows it.
        const groups = [];
        let cur = null;
        for (const t of tokens) {
            if (/[NSEW]/.test(t)) {
                if (cur && !cur.hemi && cur.nums.length) {
                    cur.hemi = t;                       // trailing letter
                    groups.push(cur);
                    cur = null;
                } else {
                    if (cur) groups.push(cur);
                    cur = { hemi: t, nums: [] };        // leading letter
                }
            } else {
                if (!cur) cur = { hemi: null, nums: [] };
                cur.nums.push(parseFloat(t));
            }
        }
        if (cur) groups.push(cur);

        // degrees + minutes/60 + seconds/3600
        function toDeg(nums) {
            if (!nums.length || nums.length > 3) return null;
            for (let i = 1; i < nums.length; i++) {
                if (nums[i] < 0 || nums[i] >= 60) return null;
            }
            const sign = nums[0] < 0 ? -1 : 1;
            let v = Math.abs(nums[0]);
            if (nums.length > 1) v += nums[1] / 60;
            if (nums.length > 2) v += nums[2] / 3600;
            return sign * v;
        }

        let lat = null, lon = null;
        const tagged = groups.filter(function (g) { return g.hemi; });

        if (tagged.length === 2) {
            for (const g of tagged) {
                const v = toDeg(g.nums);
                if (v === null) return null;
                const signed = /[SW]/.test(g.hemi) ? -Math.abs(v) : Math.abs(v);
                if (/[NS]/.test(g.hemi)) { lat = signed; } else { lon = signed; }
            }
        } else if (!tagged.length) {
            // No hemisphere letters: 2 numbers = decimal degrees, 4 = DDM, 6 = DMS
            const nums = groups.reduce(function (a, g) { return a.concat(g.nums); }, []);
            if (nums.length % 2 !== 0 || nums.length < 2 || nums.length > 6) return null;
            const half = nums.length / 2;
            lat = toDeg(nums.slice(0, half));
            lon = toDeg(nums.slice(half));
        } else {
            return null;
        }

        if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) return null;
        // Bare numbers carry no lat/lon order, so tolerate them being swapped.
        // With N/S/E/W the roles are explicit: an out-of-range value there is an
        // error, not a swap, and quietly reinterpreting it would hand back a
        // plausible-looking but wrong position.
        if (!tagged.length && Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
            const t = lat; lat = lon; lon = t;
        }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        return { lat: lat, lon: lon };
    }

    // Back to geocaching's own notation, so the parse can be eyeballed.
    function formatDdm(lat, lon) {
        function one(v, pos, neg, pad) {
            const d = Math.floor(Math.abs(v));
            const m = (Math.abs(v) - d) * 60;
            return (v < 0 ? neg : pos) + ' ' + String(d).padStart(pad, '0') +
                '° ' + (m < 10 ? '0' : '') + m.toFixed(3);
        }
        return one(lat, 'N', 'S', 2) + ' ' + one(lon, 'E', 'W', 3);
    }

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
            // position + z-index give the container its own stacking context.
            // Without it Leaflet's internal z-indexes (panes 400, controls up
            // to 1000) land in the page's root stacking context and punch
            // through geocaching.com's own overlays -- most visibly through
            // its map's full-screen mode.
            '#kp-map{height:400px;margin:10px 0;border:1px solid #ccc;' +
            'position:relative;z-index:0;}' +
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
            '.kp-road-control a.active{background:#4a90d9;color:#fff;}' +
            // (The old .kp-cadastral red-recolour filter is gone: the INSPIRE
            // WMS that rendered the boundaries in flat black was shut down, and
            // its WMTS replacement already ships MML's own cadastral styling.)
            '.kp-measure-tip{background:#fff;border:1px solid #4dabf7;color:#0b60b0;' +
            'font-weight:bold;padding:1px 6px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.3);}' +
            '.kp-measure-tip:before{display:none;}' +
            '.kp-coord-control{background:#fff;border-radius:5px;' +
            'box-shadow:0 1px 5px rgba(0,0,0,0.4);}' +
            '.leaflet-touch .kp-coord-control{border:2px solid rgba(0,0,0,0.2);box-shadow:none;}' +
            '.kp-coord-control input{border:0;border-radius:5px;padding:7px 9px;width:185px;' +
            'font:12px/1.2 monospace;color:#222;background:transparent;outline:none;}' +
            '.kp-coord-control.kp-coord-bad{box-shadow:0 0 0 2px #c00;}' +
            '.kp-coord-control.kp-coord-bad input{background:#ffe8e8;color:#900;}' +
            // ASF warning. The two zones get deliberately different colours,
            // matching the polygon shades on the map: deep red = ydinalue
            // (strictest), orange = tartuntavyöhyke.
            '.kp-asf-warn{margin:10px 0;border:2px solid;border-radius:4px;' +
            'overflow:hidden;font-size:13px;line-height:1.45;}' +
            '.kp-asf-warn .kp-asf-head{padding:7px 12px;color:#fff;font-weight:bold;' +
            'font-size:15px;letter-spacing:0.4px;}' +
            '.kp-asf-warn .kp-asf-body{padding:9px 12px;}' +
            '.kp-asf-warn ul{margin:7px 0 0 18px;padding:0;}' +
            '.kp-asf-warn li{margin:2px 0;}' +
            '.kp-asf-warn .kp-asf-where{font-weight:bold;}' +
            '.kp-asf-warn .kp-asf-note{display:block;margin-top:9px;font-weight:normal;' +
            'font-size:11px;line-height:1.4;color:#666;}' +
            '.kp-asf-warn .kp-asf-note a{color:#666;}' +
            '.kp-asf-core{border-color:#8b1a00;background:#ffeceb;color:#5c1000;}' +
            '.kp-asf-core .kp-asf-head{background:#8b1a00;}' +
            '.kp-asf-core a{color:#8b1a00;}' +
            '.kp-asf-zone{border-color:#b35806;background:#fff5e8;color:#6b3505;}' +
            '.kp-asf-zone .kp-asf-head{background:#b35806;}' +
            '.kp-asf-zone a{color:#b35806;}');

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

        // Custom panes, so the overlays stack in a predictable order. Leaflet
        // puts every tile layer in tilePane (z 200) and every vector in
        // overlayPane (z 400), which would paint the translucent ASF fill on
        // top of the cadastral / road-owner lines and wash them out. Instead:
        // ASF shading just above the base map, the two WMS overlays above it.
        map.createPane('kpAsf').style.zIndex = 250;
        map.createPane('kpWms').style.zIndex = 350;

        // The stacking context above handles the CSS side, but geocaching.com's
        // map can also go full screen via the Fullscreen API. If it does so on
        // an ancestor of our container, our map is inside the full-screen
        // subtree and keeps rendering on top of theirs. Nothing of ours is
        // useful in that view, so take it out while somebody else owns the
        // screen and put it back afterwards.
        function kpOwnElements() {
            return [mapDiv].concat(
                Array.prototype.slice.call(document.querySelectorAll('.kp-asf-warn')));
        }
        function onFullscreenChange() {
            const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
            const hide = !!fs && fs !== mapDiv && !mapDiv.contains(fs);
            kpOwnElements().forEach(function (el) {
                el.style.display = hide ? 'none' : '';
            });
            // Leaflet measures the container on show; it was 0x0 while hidden.
            if (!hide) { setTimeout(function () { map.invalidateSize(); }, 0); }
        }
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);

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
            pane: 'kpWms',
            attribution: '&copy; Väylävirasto, Digiroad'
        });

        // --- Overlay: cadastral boundaries (MML karttakuvapalvelu WMTS) --
        // "Kiinteistörajat" — the same boundaries shown in Kansalaisen
        // Karttapaikka.
        //
        // This used to come from the keyless INSPIRE WMS at
        // inspire-wms.maanmittauslaitos.fi/inspire-wms/cp/wms. That service has
        // been shut down (the host now refuses connections outright), so the
        // layer is taken from the same open WMTS as the MML base maps and needs
        // the API key. It is served as a transparent PNG8 in MML's own cadastral
        // styling, so no client-side recolouring is needed any more.
        //
        // The open service only has zoom levels 12-16 in WGS84_Pseudo-Mercator
        // (contract customers get 12-18). maxNativeZoom lets Leaflet upscale the
        // z16 tiles past that instead of requesting tiles that do not exist.
        const cadastral = L.tileLayer(mmlUrl('kiinteistojaotus'), {
            minZoom: 12,
            maxNativeZoom: 16,
            maxZoom: 20,
            pane: 'kpWms',
            attribution: '&copy; Maanmittauslaitos'
        });

        // --- Overlay: ASF zones (afrikkalainen sikarutto) ----------------
        // Drawn from the baked-in rings, see ASF_ZONES above. The core zone
        // is drawn last so it stays clickable on top of the infected zone.
        // The two zones use the same colours as the warning banners below, so
        // the banner tells you at a glance which shade on the map you are in.
        const asfLayer = L.layerGroup();
        const asfInfected = L.polygon(asfLatLngs(ASF_ZONES.tartuntavyohyke), {
            pane: 'kpAsf',
            color: '#b35806', weight: 4, opacity: 0.95,
            fillColor: '#f16913', fillOpacity: 0.30
        });
        const asfCore = L.polygon(asfLatLngs(ASF_ZONES.ydinalue), {
            pane: 'kpAsf',
            color: '#7f2704', weight: 4, opacity: 1,
            fillColor: '#a63603', fillOpacity: 0.28
        });

        // The fill has two jobs that pull in opposite directions: zoomed out it
        // has to show at a glance where the zones are, zoomed in it must not
        // bury the terrain the reviewer is actually looking at. So scale it
        // with the zoom level instead of picking one compromise value.
        // bringToBack sends a layer all the way back, so the last call wins:
        // B ends up behind A, leaving the core zone on top of both.
        function styleAsfForZoom() {
            const z = map.getZoom();
            const base = z >= 15 ? 0.15 : z >= 13 ? 0.22 : z >= 11 ? 0.30 : 0.36;
            asfInfected.setStyle({ fillOpacity: base });
            asfCore.setStyle({ fillOpacity: Math.min(0.55, base * 1.85) });
        }
        map.on('zoomend', styleAsfForZoom);
        // No popups on the polygons: the restrictions are already spelled out
        // in the warning above the map, and a click-through callout on a shape
        // that covers half the view just gets in the way.
        asfLayer.addLayer(asfInfected);
        asfLayer.addLayer(asfCore);

        const overlayMaps = {
            'Etäisyysrenkaat': rangeLayer,
            'Sikaruttovyöhykkeet': asfLayer
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

        // --- Cadastral-boundary toggle control (below the road button) ---
        // Simple on/off overlay: just adds/removes the property boundaries on
        // top of the current map, without changing the base layer.
        const CAD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M3 3h18v18H3z"/><path d="M3 10h9M12 3v14M12 14h9"/></svg>';

        let cadastralActive = false;
        let cadLink = null;

        function toggleCadastral() {
            cadastralActive = !cadastralActive;
            if (cadastralActive) {
                cadastral.addTo(map);
                cadastral.bringToFront();
                if (cadLink) {
                    cadLink.title = 'Piilota kiinteistörajat';
                    cadLink.classList.add('active');
                }
            } else {
                if (map.hasLayer(cadastral)) { map.removeLayer(cadastral); }
                if (cadLink) {
                    cadLink.title = 'Näytä kiinteistörajat';
                    cadLink.classList.remove('active');
                }
            }
        }

        const CadControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                cadLink = L.DomUtil.create('a', '', container);
                cadLink.href = '#';
                cadLink.title = 'Näytä kiinteistörajat';
                cadLink.setAttribute('aria-label', 'Kiinteistörajat');
                cadLink.innerHTML = CAD_ICON;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(cadLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    toggleCadastral();
                });
                return container;
            }
        });
        // The WMTS cadastral layer needs the MML API key, so without one there
        // is nothing the button could show. (Neither are the MML base maps
        // available in that case, so a missing button is consistent.)
        if (apiKey) {
            map.addControl(new CadControl());
        }

        // --- Distance measurement tool (below the cadastral button) ------
        // Two-point measurement that snaps to the known points (cache zero
        // point + all waypoints, collected in measurePoints). Activate ->
        // click a start point (snaps to the nearest known point if you click
        // near one) -> a light-blue rubber-band line follows the cursor with a
        // live distance tooltip (the end also snaps) -> click again to lock.
        // The line stays; pressing the button again resets / starts anew.
        const MEASURE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M14.5 2.5 21.5 9.5 9.5 21.5 2.5 14.5z"/>' +
            '<path d="M7 11l1.5 1.5M10 8l1.5 1.5M13 5l1.5 1.5"/></svg>';

        // Known snap targets: cache zero point first, waypoints pushed below.
        const measurePoints = [L.latLng(latitude, longitude)];
        const SNAP_PX = 20;
        let measureActive = false;
        let measureStart = null;
        let measureLine = null;
        let measureTip = null;
        let measLink = null;

        function fmtDist(m) {
            return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
        }
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
                measureLine = L.polyline([from, to], {
                    color: '#4dabf7', weight: 3, opacity: 0.9, dashArray: dash
                }).addTo(map);
            } else {
                measureLine.setLatLngs([from, to]);
                measureLine.setStyle({ dashArray: dash });
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
        function onMeasureMove(e) {
            if (!measureStart) return;
            measureDraw(measureStart, snapLatLng(e.latlng), false);
        }
        function onMeasureClick(e) {
            const pt = snapLatLng(e.latlng);
            if (!measureStart) {
                measureStart = pt;                 // first click sets the start point
                return;
            }
            measureDraw(measureStart, pt, true);   // second click locks the line
            stopMeasureMode();                     // line + tooltip stay on the map
        }
        function stopMeasureMode() {
            map.off('mousemove', onMeasureMove);
            map.off('click', onMeasureClick);
            map.getContainer().style.cursor = '';
            measureActive = false;
            if (measLink) { measLink.classList.remove('active'); measLink.title = 'Mittaa etäisyys'; }
        }
        function toggleMeasure() {
            if (measureActive) {           // pressing while measuring = cancel + clear
                stopMeasureMode();
                clearMeasure();
                return;
            }
            clearMeasure();                // fresh start: reset any previous line
            measureActive = true;
            if (measLink) { measLink.classList.add('active'); measLink.title = 'Lopeta / nollaa mittaus'; }
            map.getContainer().style.cursor = 'crosshair';
            map.on('mousemove', onMeasureMove);
            map.on('click', onMeasureClick);
        }

        const MeasureControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                measLink = L.DomUtil.create('a', '', container);
                measLink.href = '#';
                measLink.title = 'Mittaa etäisyys';
                measLink.setAttribute('aria-label', 'Mittaa etäisyys');
                measLink.innerHTML = MEASURE_ICON;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(measLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    toggleMeasure();
                });
                return container;
            }
        });
        map.addControl(new MeasureControl());

        // --- Swine-fever zone toggle control (below the measure button) --
        // The same layer is also in the layer selector; the two stay in sync
        // because the button state is driven by the map's layeradd/layerremove
        // events rather than by the click handler.
        // A pig's snout, shaped after the 🐽 emoji: a solid rounded-rectangle
        // muzzle rather than a plain ellipse. The nostrils are subpaths of the
        // same path and fill-rule="evenodd" turns them into real holes, so the
        // button's own background shows through them -- white normally, blue
        // when active -- without having to know which state we are in.
        const ASF_ICON = '<svg viewBox="0 0 24 24" width="23" height="23">' +
            '<path fill="currentColor" fill-rule="evenodd" d="' +
            'M8 5H16A5.5 5.5 0 0 1 21.5 10.5V13.5A5.5 5.5 0 0 1 16 19H8' +
            'A5.5 5.5 0 0 1 2.5 13.5V10.5A5.5 5.5 0 0 1 8 5Z' +
            'M6.7 12a1.9 3.1 0 1 0 3.8 0a1.9 3.1 0 1 0-3.8 0Z' +
            'M13.5 12a1.9 3.1 0 1 0 3.8 0a1.9 3.1 0 1 0-3.8 0Z' +
            '"/></svg>';

        let asfLink = null;

        function updateAsfButton() {
            if (!asfLink) return;
            const on = map.hasLayer(asfLayer);
            asfLink.title = on ? 'Piilota sikaruttovyöhykkeet' : 'Näytä sikaruttovyöhykkeet';
            asfLink.classList.toggle('active', on);
        }
        map.on('layeradd layerremove', function (e) {
            if (e.layer === asfLayer) { updateAsfButton(); }
        });

        const AsfControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                asfLink = L.DomUtil.create('a', '', container);
                asfLink.href = '#';
                asfLink.setAttribute('aria-label', 'Sikaruttovyöhykkeet');
                asfLink.innerHTML = ASF_ICON;
                updateAsfButton();
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(asfLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    if (map.hasLayer(asfLayer)) {
                        map.removeLayer(asfLayer);
                    } else {
                        asfLayer.addTo(map);
                        asfInfected.bringToBack();
                    }
                });
                return container;
            }
        });
        map.addControl(new AsfControl());

        // --- Coordinate search box (bottom left) -------------------------
        // Paste coordinates in any of the formats parseCoords understands and
        // press Enter: the map jumps to the spot and drops a marker there. The
        // marker also becomes a snap target for the measuring tool, which is
        // the point of it -- checking the distance from a coordinate someone
        // quoted in a log or a reviewer note.
        let searchMarker = null;

        function showSearchedPoint(lat, lon) {
            const here = L.latLng(lat, lon);
            if (searchMarker) { map.removeLayer(searchMarker); }
            searchMarker = L.circleMarker(here, {
                radius: 8, color: '#0b60b0', weight: 3,
                fillColor: '#4dabf7', fillOpacity: 0.9
            }).addTo(map);

            const zone = asfZoneAt(lat, lon);
            const zoneNote = zone
                ? '<br/><b style="color:#8b1a00">⚠ Sikaruton ' +
                  (ASF_INFO[zone].name) + '</b>'
                : '';

            searchMarker.bindPopup(
                '<b>Haettu piste</b><br/>' + formatDdm(lat, lon) +
                '<br/>' + lat.toFixed(5) + ', ' + lon.toFixed(5) +
                '<br/>Etäisyys nollapisteestä: ' +
                fmtDist(map.distance(here, L.latLng(latitude, longitude))) +
                zoneNote +
                '<br/><a target="_blank" href="' + karttapaikkaLink(lat, lon) + '">Karttapaikka</a>' +
                '<br/>' + streetViewLink(lat, lon));

            measurePoints.push(here);
            map.setView(here, Math.max(map.getZoom(), 15));
            searchMarker.openPopup();
        }

        const CoordControl = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-coord-control');
                const input = L.DomUtil.create('input', '', container);
                input.type = 'text';
                input.placeholder = 'N 60 36.000 E 27 48.600';
                input.title = 'Syötä koordinaatit ja paina Enter';
                input.setAttribute('aria-label', 'Hae koordinaateilla');

                // Keep the map from treating typing and clicking as map input.
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
                L.DomEvent.on(input, 'keydown keypress keyup', L.DomEvent.stopPropagation);

                L.DomEvent.on(input, 'keydown', function (e) {
                    container.classList.remove('kp-coord-bad');
                    if (e.key !== 'Enter') return;
                    L.DomEvent.preventDefault(e);
                    const c = parseCoords(input.value);
                    if (!c) {
                        container.classList.add('kp-coord-bad');
                        input.title = 'Koordinaatteja ei tunnistettu';
                        return;
                    }
                    input.title = 'Syötä koordinaatit ja paina Enter';
                    input.value = formatDdm(c.lat, c.lon);   // echo the parse back
                    showSearchedPoint(c.lat, c.lon);
                });
                return container;
            }
        });
        map.addControl(new CoordControl());

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
        const asfPoints = [{ label: 'Nollapiste', lat: latitude, lon: longitude }];

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
            measurePoints.push(L.latLng(wpLat, wpLon)); // snap target for measuring
            asfPoints.push({ label: wpType, lat: wpLat, lon: wpLon });
        }

        if (waypointCount > 0) {
            map.fitBounds(bounds.pad(0.2));
        }

        // --- ASF check: warn in red if any point is inside a zone --------
        // The overlay is switched on automatically whenever the cache is in
        // the neighbourhood of the infected zone, so the reviewer sees the
        // zone even when the cache itself falls just outside it.
        const asfHits = [];
        let asfNear = false;
        asfPoints.forEach(function (p) {
            const zone = asfZoneAt(p.lat, p.lon);
            if (zone) { asfHits.push({ point: p, zone: zone }); }
            if (inBBox(p.lat, p.lon, ASF_BBOX.tartuntavyohyke, 0.25)) { asfNear = true; }
        });

        if (asfNear) {
            asfLayer.addTo(map);
            asfInfected.bringToBack();
        }
        styleAsfForZoom();   // the view is final by now (fitBounds may have moved it)

        if (asfHits.length) {
            // The strictest zone any point falls in decides the banner: those
            // are the restrictions that actually decide the cache.
            const worst = asfHits.reduce(function (a, b) {
                return ASF_ORDER.indexOf(b.zone) < ASF_ORDER.indexOf(a.zone) ? b : a;
            }).zone;
            const info = ASF_INFO[worst];

            const where = asfHits.map(function (h) {
                return h.point.label + ' (' + ASF_INFO[h.zone].name + ')';
            }).join(', ');

            const warn = document.createElement('div');
            warn.className = 'kp-asf-warn ' + info.css;
            warn.innerHTML =
                '<div class="kp-asf-head">' + info.head + '</div>' +
                '<div class="kp-asf-body">' +
                '<span class="kp-asf-where">' + where + '</span>' +
                '<ul>' +
                info.rules.map(function (r) { return '<li>' + r + '</li>'; }).join('') +
                '</ul>' +
                '<span class="kp-asf-note">Rajaus on piirretty Ruokaviraston p\u00e4\u00e4t' +
                '\u00f6ksen (' + ASF_UPDATED + ') ja sen karttaliitteen pohjalta, eik\u00e4 ' +
                'se ole virallinen paikkatieto. Tarkista aina ' +
                '<a target="_blank" href="' + ASF_MAP_URL + '">virallinen kartta</a> ja ' +
                '<a target="_blank" href="' + ASF_INFO_URL + '">Ruokaviraston ohjeet</a>.' +
                '</span>' +
                '</div>';

            mapDiv.parentNode.insertBefore(warn, mapDiv);
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
