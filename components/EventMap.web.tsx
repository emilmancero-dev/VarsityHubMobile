import { resolveMarkerColor } from '@/utils/mapMarkerColor';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { EventMapProps } from './EventMap.types';

type MarkerPayload = {
  id: string;
  title: string;
  color: string;
  latitude: number;
  longitude: number;
  type?: 'game' | 'event' | 'post';
};

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

const iframeStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 0,
  display: 'block',
};

function buildMapDocument(markers: MarkerPayload[], mapId: string, isDark: boolean): string {
  const markerJson = JSON.stringify(markers).replace(/</g, '\\u003c');
  const tileUrl = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const attribution = isDark
    ? '&copy; OpenStreetMap contributors &copy; CARTO'
    : '&copy; OpenStreetMap contributors';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${LEAFLET_CSS}" />
  <style>
    html, body, #map {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: ${isDark ? '#121212' : '#f8fafc'};
    }
    .leaflet-container {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .event-popup {
      min-width: 180px;
    }
    .event-popup h3 {
      margin: 0 0 6px;
      font-size: 14px;
      line-height: 1.3;
    }
    .event-popup button {
      border: 0;
      border-radius: 8px;
      background: #0a7ea4;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      padding: 8px 10px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="${LEAFLET_JS}"></script>
  <script>
    const markers = ${markerJson};
    const map = L.map('map', { zoomControl: true, attributionControl: true });
    const tileLayer = L.tileLayer('${tileUrl}', {
      maxZoom: 19,
      attribution: '${attribution}'
    });
    tileLayer.addTo(map);

    const bounds = [];

    markers.forEach(marker => {
      const position = [marker.latitude, marker.longitude];
      bounds.push(position);
      const leafletMarker = L.circleMarker(position, { radius: 9, color: marker.color, fillColor: marker.color, fillOpacity: 1, weight: 2 }).addTo(map);
      const title = String(marker.title || 'Event');
      const safeTitle = title
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const popupHtml =
        '<div class="event-popup">' +
        '<h3>' + safeTitle + '</h3>' +
        '<button type="button" data-id="' + marker.id + '">Open details</button>' +
        '</div>';
      leafletMarker.bindPopup(popupHtml);
      leafletMarker.on('click', () => {
        window.parent.postMessage(
          { source: 'varsityhub-web-map', mapId: '${mapId}', eventId: marker.id, eventType: marker.type || 'game' },
          '*'
        );
      });
    });

    if (bounds.length === 1) {
      map.setView(bounds[0], 12);
    } else {
      map.fitBounds(bounds, { padding: [24, 24] });
    }

    document.addEventListener('click', event => {
      const button = event.target.closest('button[data-id]');
      if (!button) return;
      const eventId = button.getAttribute('data-id');
      const marker = markers.find(item => item.id === eventId);
      if (!marker) return;
      window.parent.postMessage(
        { source: 'varsityhub-web-map', mapId: '${mapId}', eventId: marker.id, eventType: marker.type || 'game' },
        '*'
      );
    });
  </script>
</body>
</html>`;
}

export default function EventMapWeb({ events, onEventPress, dataLoaded = true }: EventMapProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const mapIdRef = useRef(`vh-web-map-${Math.random().toString(36).slice(2)}`);

  const markers = useMemo(
    () =>
      events
        .filter(
          event =>
            event.latitude != null &&
            event.longitude != null &&
            !Number.isNaN(event.latitude) &&
            !Number.isNaN(event.longitude)
        )
        .map(event => ({
          id: String(event.id),
          title: event.title,
          color: resolveMarkerColor(event),
          latitude: Number(event.latitude),
          longitude: Number(event.longitude),
          type: event.type,
        })),
    [events, colorScheme]
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (
        !payload ||
        payload.source !== 'varsityhub-web-map' ||
        payload.mapId !== mapIdRef.current ||
        typeof payload.eventId !== 'string'
      ) {
        return;
      }
      onEventPress?.(payload.eventId, payload.eventType);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onEventPress]);

  const srcDoc = useMemo(
    () => buildMapDocument(markers, mapIdRef.current, colorScheme === 'dark'),
    [colorScheme, markers]
  );

  if (markers.length === 0) {
    return (
      <View
        style={[
          styles.emptyContainer,
          {
            borderColor: Colors[colorScheme].border,
            backgroundColor: Colors[colorScheme].surface,
          },
        ]}
      >
        <Text style={[styles.title, { color: Colors[colorScheme].text }]}>
          {dataLoaded ? 'No matching events on the map' : 'Loading Map'}
        </Text>
        <Text style={[styles.subtitle, { color: Colors[colorScheme].mutedText }]}>
          {dataLoaded
            ? 'Try another date, sport, or league. Only events with a mapped location appear here.'
            : 'Preparing nearby games map.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <View
        style={[
          styles.frameShell,
          {
            borderColor: Colors[colorScheme].border,
            backgroundColor: Colors[colorScheme].surface,
          },
        ]}
      >
        <iframe
          sandbox="allow-scripts allow-same-origin"
          srcDoc={srcDoc}
          title="Nearby games map"
          style={iframeStyle}
        />
      </View>
      <View style={styles.legendRow}>
        <Text style={[styles.legendText, { color: Colors[colorScheme].mutedText }]}>
          Gold: has posts. Other colors: team/sport. Tap a marker for details.
        </Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            const firstMarker = markers[0];
            window.open(
              `https://www.google.com/maps/search/?api=1&query=${firstMarker.latitude},${firstMarker.longitude}`,
              '_blank',
              'noopener,noreferrer'
            );
          }}
        >
          <Text style={[styles.openText, { color: Colors[colorScheme].tint }]}>
            Open in Google Maps
          </Text>
        </Pressable>
      </View>
      <View style={styles.eventList}>
        {markers.slice(0, 6).map(marker => (
          <Pressable
            key={marker.id}
            onPress={() => onEventPress?.(marker.id, marker.type)}
            style={[
              styles.eventRow,
              {
                backgroundColor: Colors[colorScheme].surface,
                borderColor: Colors[colorScheme].border,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.eventTitle, { color: Colors[colorScheme].text }]}
            >
              {marker.title}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    gap: 12,
    padding: 12,
  },
  frameShell: {
    flex: 1,
    minHeight: 420,
    overflow: 'hidden',
    borderWidth: 1,
    borderRadius: 16,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  legendText: {
    flex: 1,
    fontSize: 13,
  },
  openText: {
    fontSize: 13,
    fontWeight: '700',
  },
  eventList: {
    gap: 8,
  },
  eventRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  eventTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  emptyContainer: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 320,
    gap: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
});
