// ==UserScript==
// @name         Final to karttapaikka
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Add Link to Kansalaisen Karttapaikka to final location of the geocache on review page
// @author       Veli-Pekka Eloranta
// @match        https://*.geocaching.com/*
// @updateURL    https://github.com/weellu/kpRevScript/blob/main/FinaltoKarttapaikka.user.js
// @updateURL    https://github.com/weellu/kpRevScript/blob/main/FinaltoKarttapaikka.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Function to create and insert the link after the span element
    function addLinkAfterSpan() {
        // Find all span elements with matching ids
        const spans = document.querySelectorAll('[id^="ctl00_ContentBody_Waypoints_Waypoints_ctl"][id$="_uxDistance"]');

        // If there are any matching span elements
        if (spans.length > 0) {
            // Iterate over each matching span element
            var iteration = 0;
            spans.forEach((targetSpan) => {
                // Get the parent <td> element of the target span
                const parentTd = targetSpan.closest('td');

                // Create the link element
                const link = document.createElement('a');
                const latitude = $("#ctl00_ContentBody_CacheDataControl1_CacheData").attr("data-wp_"+iteration+"_latitude");
                const longitude = $("#ctl00_ContentBody_CacheDataControl1_CacheData").attr("data-wp_"+iteration+"_longitude");

                // Build the link URL for Kansalaisen Karttapaikka
                link.href = 'https://asiointi.maanmittauslaitos.fi/karttapaikka/api/linkki?x=' + latitude + '&y=' + longitude + '&srs=EPSG:4258&scale=4000';
                link.textContent = 'View on Kansalaisen Karttapaikka'; // Link text
                link.target = '_blank';

                // Style the link (optional)
                link.style.display = 'block';
                link.style.marginLeft = '10px';
                link.style.textDecoration = 'none';
                link.style.color = '#0066cc';

                // Insert the link after the target span
                parentTd.appendChild(link);
                iteration++;
            });
        }
    }

    // Run the function to add the link
    window.addEventListener('load', addLinkAfterSpan);
})();
