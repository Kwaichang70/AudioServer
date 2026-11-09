import ssdp from 'node-ssdp';
const { Client: SsdpClient } = ssdp;
import xml2js from 'xml2js';
const { parseStringPromise } = xml2js;
import { logger } from '../logger.js';
import type {
  DeviceController,
  OutputDevice,
  DevicePlaybackStatus,
  TrackMetadata,
} from '@audioserver/shared';
import {
  buildDidlLite,
  DESCRIPTION_TIMEOUT_MS,
  escapeXml,
  mimeTypeOf,
  requestSignal,
} from './upnp.js';
import { DiscoveryRoster } from './retention.js';

interface DlnaDevice {
  id: string;
  name: string;
  host: string;
  controlUrl: string;
  /** AVTransport's service description; lists the actions this renderer really has (V11.1). */
  scpdUrl?: string;
  /** ConnectionManager control URL; GetProtocolInfo says which formats it accepts. */
  connectionManagerUrl?: string;
  location: string;
  isOnline: boolean;
}

/** One bounded GET; a renderer that does not answer must not hang a request. */
async function fetchText(url: string, timeoutMs = 5000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.text();
}

/**
 * The Sink half of a GetProtocolInfo answer, reduced to mime types. A line
 * looks like `http-get:*:audio/flac:DLNA.ORG_PN=...`; only the third field is
 * a format. Anything that is not audio is dropped — this is a music player.
 */
export function parseSinkProtocolInfo(xml: string): string[] {
  const sink = xml.match(/<Sink>([\s\S]*?)<\/Sink>/)?.[1] ?? '';
  const decoded = sink.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const formats = new Set<string>();
  for (const entry of decoded.split(',')) {
    const mime = entry.split(':')[2]?.trim();
    if (mime && mime.startsWith('audio/')) formats.add(mime);
  }
  return [...formats].sort();
}

/** Seconds → `H:MM:SS`, the REL_TIME format AVTransport expects. */
/** The URL a renderer reports in GetPositionInfo, XML entities decoded; undefined when empty. */
export function parseTrackUri(positionInfo: string): string | undefined {
  const raw = positionInfo.match(/<TrackURI>([^<]*)<\/TrackURI>/)?.[1]?.trim();
  if (!raw) return undefined;
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function formatRelTime(position: number): string {
  const total = Math.max(0, Math.floor(position));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export class DlnaController implements DeviceController {
  readonly deviceType = 'dlna' as const;
  private devices = new Map<string, DlnaDevice>();
  private readonly roster = new DiscoveryRoster<DlnaDevice>();

  async discover(): Promise<OutputDevice[]> {
    // Collected apart and merged at the end: the known devices stay usable
    // while the search runs, and one missed round does not forget them (P01).
    const found = new Map<string, DlnaDevice>();

    // Method 1: SSDP multicast discovery
    await this.ssdpDiscover(found);

    // Method 2: Direct HTTP probing of known/configured devices
    await this.probeKnownDevices(found);

    this.devices = this.roster.merge(this.devices, found);
    return this.getDeviceList();
  }

  private async ssdpDiscover(found: Map<string, DlnaDevice>): Promise<void> {
    return new Promise((resolve) => {
      try {
        const client = new SsdpClient();

        client.on('response', async (headers, _statusCode, rinfo) => {
          if (!headers.LOCATION) return;
          try {
            await this.parseDeviceDescription(String(headers.LOCATION), rinfo.address, found);
          } catch {
            // Not a valid MediaRenderer
          }
        });

        client.search('urn:schemas-upnp-org:device:MediaRenderer:1');

        setTimeout(() => {
          client.stop();
          resolve();
        }, 4000);
      } catch (err) {
        logger.warn(`SSDP discovery failed: ${err}`);
        resolve();
      }
    });
  }

  private async probeKnownDevices(found: Map<string, DlnaDevice>): Promise<void> {
    // Probe common UPnP ports on known/recently-seen devices
    // Also probe addresses from DLNA_DEVICES env var (comma-separated host:port)
    const probeTargets: string[] = [];

    const envDevices = process.env.DLNA_DEVICES || '';
    if (envDevices) {
      probeTargets.push(
        ...envDevices
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }

    // If no explicit targets, skip probing (user should set DLNA_DEVICES)
    if (probeTargets.length === 0) return;

    await Promise.allSettled(
      probeTargets.map(async (target) => {
        const [host, port] = target.includes(':') ? target.split(':') : [target, '49152'];
        try {
          const descUrl = await this.findDescriptionUrl(host, parseInt(port));
          if (descUrl) {
            await this.parseDeviceDescription(descUrl, host, found);
          }
        } catch {
          // Device not reachable on this port
        }
      }),
    );
  }

  private async findDescriptionUrl(host: string, port: number): Promise<string | null> {
    // Try common UPnP description paths
    const paths = [
      '/', // Cocktail Audio, some renderers
      '/xml/device_description.xml', // Sonos
      '/description.xml', // Generic UPnP
      '/rootDesc.xml', // Some renderers
      '/DeviceDescription.xml', // Volumio/MPD
    ];

    for (const path of paths) {
      try {
        const url = `http://${host}:${port}${path}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const text = await res.text();
          if (text.includes('MediaRenderer') || text.includes('AVTransport')) {
            return url;
          }
        }
      } catch {
        // Not available on this path
      }
    }
    return null;
  }

  private async parseDeviceDescription(
    location: string,
    host: string,
    into: Map<string, DlnaDevice>,
  ): Promise<void> {
    try {
      // Every UPnP device on the host network answers the search; one that
      // accepts the connection and never sends its description must not hold
      // discovery open (P10).
      const res = await fetch(location, { signal: AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS) });
      const xml = await res.text();
      const parsed = await parseStringPromise(xml);

      const device = parsed?.root?.device?.[0];
      if (!device) return;

      const friendlyName = device.friendlyName?.[0] || 'Unknown DLNA Device';
      const udn = device.UDN?.[0] || `dlna-${host}`;

      // Find AVTransport service, and ConnectionManager alongside it: the
      // first says which actions exist (SetNextAVTransportURI), the second
      // which formats the renderer accepts (V11.1).
      let controlUrl = '';
      let scpdUrl = '';
      let connectionManagerUrl = '';
      const services = device.serviceList?.[0]?.service || [];
      for (const svc of services) {
        const serviceType = svc.serviceType?.[0] || '';
        if (serviceType.includes('AVTransport') && !controlUrl) {
          controlUrl = svc.controlURL?.[0] || '';
          scpdUrl = svc.SCPDURL?.[0] || '';
        }
        if (serviceType.includes('ConnectionManager') && !connectionManagerUrl) {
          connectionManagerUrl = svc.controlURL?.[0] || '';
        }
      }

      // Also check embedded devices (some renderers nest the service)
      if (!controlUrl && device.deviceList?.[0]?.device) {
        for (const embedded of device.deviceList[0].device) {
          const embeddedServices = embedded.serviceList?.[0]?.service || [];
          for (const svc of embeddedServices) {
            if (svc.serviceType?.[0]?.includes('AVTransport')) {
              controlUrl = svc.controlURL?.[0] || '';
              scpdUrl = svc.SCPDURL?.[0] || '';
            }
            if (svc.serviceType?.[0]?.includes('ConnectionManager') && !connectionManagerUrl) {
              connectionManagerUrl = svc.controlURL?.[0] || '';
            }
          }
          if (controlUrl) break;
        }
      }

      if (!controlUrl) return;

      // Build absolute control URL
      const base = new URL(location);
      const absoluteControlUrl = controlUrl.startsWith('http')
        ? controlUrl
        : `${base.protocol}//${base.host}${controlUrl}`;

      const absolute = (url: string): string | undefined => {
        if (!url) return undefined;
        return url.startsWith('http') ? url : `${base.protocol}//${base.host}${url}`;
      };

      const id = udn.replace('uuid:', '');
      into.set(id, {
        id,
        name: friendlyName,
        host,
        controlUrl: absoluteControlUrl,
        scpdUrl: absolute(scpdUrl),
        connectionManagerUrl: absolute(connectionManagerUrl),
        location,
        isOnline: true,
      });

      logger.info(`DLNA device found: ${friendlyName} at ${host} (${absoluteControlUrl})`);
    } catch {
      // Failed to parse, skip
    }
  }

  private getDeviceList(): OutputDevice[] {
    return Array.from(this.devices.values()).map((d) => ({
      id: d.id,
      name: d.name,
      type: 'dlna' as const,
      host: d.host,
      isOnline: d.isOnline,
    }));
  }

  private getDevice(deviceId: string): DlnaDevice {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`DLNA device not found: ${deviceId}`);
    return device;
  }

  async play(
    deviceId: string,
    streamUrl: string,
    metadata?: TrackMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const device = this.getDevice(deviceId);
    const didl = this.didlFor(streamUrl, metadata);

    // Stop current playback
    try {
      await this.sendAction(device.controlUrl, 'Stop', { InstanceID: '0' }, signal);
      await this.waitForState(device.controlUrl, 'STOPPED', 3000, signal);
    } catch {
      /* ignore — may already be stopped */
    }
    // The caller gave up while we waited: sending SetURI/Play now would run
    // next to its retry on the same speaker (P06).
    signal?.throwIfAborted();

    // Set new URI
    const setResult = await this.sendAction(
      device.controlUrl,
      'SetAVTransportURI',
      {
        InstanceID: '0',
        CurrentURI: streamUrl,
        CurrentURIMetaData: didl,
      },
      signal,
    );

    if (setResult.includes('Fault')) {
      logger.error(`DLNA SetURI fault on ${device.name}: ${setResult.substring(0, 200)}`);
      throw new Error(`DLNA SetURI failed on ${device.name}`);
    }

    // Wait a moment for device to buffer
    await new Promise((r) => setTimeout(r, 500));
    signal?.throwIfAborted();

    // Play
    await this.sendAction(device.controlUrl, 'Play', { InstanceID: '0', Speed: '1' }, signal);

    // Verify it's playing (retry once if not)
    const playing = await this.waitForState(device.controlUrl, 'PLAYING', 5000, signal);
    if (!playing) {
      signal?.throwIfAborted();
      logger.warn(`DLNA: ${device.name} not PLAYING after first attempt, retrying...`);
      await this.sendAction(device.controlUrl, 'Play', { InstanceID: '0', Speed: '1' }, signal);
      await this.waitForState(device.controlUrl, 'PLAYING', 3000, signal);
    }

    logger.info(`DLNA play: ${metadata?.title || 'track'} → ${device.name}`);
  }

  /** Poll transport state until it matches expected, or timeout */
  private async waitForState(
    controlUrl: string,
    expected: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) return false;
      try {
        const info = await this.sendAction(
          controlUrl,
          'GetTransportInfo',
          { InstanceID: '0' },
          signal,
        );
        if (info.includes(expected)) return true;
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async pause(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.sendAction(device.controlUrl, 'Pause', { InstanceID: '0' });
  }

  async resume(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.sendAction(device.controlUrl, 'Play', { InstanceID: '0', Speed: '1' });
  }

  async stop(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.sendAction(device.controlUrl, 'Stop', { InstanceID: '0' });
  }

  /**
   * Hand the next track over before this one ends. Not every renderer has
   * SetNextAVTransportURI, and since V11 the failure is reported instead of
   * swallowed: the caller decides between a gapless handover and dispatching
   * the next track itself.
   */
  async setNextUri(
    deviceId: string,
    streamUrl: string,
    metadata?: TrackMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const device = this.getDevice(deviceId);
    // An empty URL clears what was handed over (the queue changed).
    const didl = streamUrl ? this.didlFor(streamUrl, metadata) : '';
    await this.sendAction(
      device.controlUrl,
      'SetNextAVTransportURI',
      {
        InstanceID: '0',
        NextURI: streamUrl,
        NextURIMetaData: didl,
      },
      signal,
    );
    logger.info(`DLNA setNextUri: ${metadata?.title || 'track'} → ${device.name}`);
  }

  /**
   * Jump inside the current track (R01.1). `REL_TIME` is the unit every
   * AVTransport renderer that supports Seek at all understands; the target is
   * a wall-clock string, not seconds.
   */
  async seek(deviceId: string, position: number): Promise<void> {
    const device = this.getDevice(deviceId);
    const result = await this.sendAction(device.controlUrl, 'Seek', {
      InstanceID: '0',
      Unit: 'REL_TIME',
      Target: formatRelTime(position),
    });
    // A renderer that does not implement Seek answers with a SOAP fault
    // instead of failing the request; without this the caller would think it
    // worked and the UI would jump to a position the speaker never went to.
    if (result.includes('Fault')) {
      throw new Error(`${device.name} refused Seek`);
    }
    logger.info(`DLNA seek: ${device.name} → ${formatRelTime(position)}`);
  }

  /**
   * The actions this renderer actually implements, from its own service
   * description (V11.1). Empty when the device does not say — never guessed.
   */
  async getSupportedActions(deviceId: string): Promise<string[]> {
    const device = this.getDevice(deviceId);
    if (!device.scpdUrl) return [];
    const xml = await fetchText(device.scpdUrl);
    const parsed = await parseStringPromise(xml);
    const actions = parsed?.scpd?.actionList?.[0]?.action ?? [];
    return actions
      .map((a: { name?: string[] }) => a.name?.[0])
      .filter((name: string | undefined): name is string => !!name);
  }

  /** The formats this renderer says it accepts (ConnectionManager GetProtocolInfo). */
  async getSupportedFormats(deviceId: string): Promise<string[]> {
    const device = this.getDevice(deviceId);
    if (!device.connectionManagerUrl) return [];
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body><u:GetProtocolInfo xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1" /></s:Body>
</s:Envelope>`;
    const res = await fetch(device.connectionManagerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const xml = await res.text();
    return parseSinkProtocolInfo(xml);
  }

  async next(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.sendAction(device.controlUrl, 'Next', { InstanceID: '0' });
  }

  async previous(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.sendAction(device.controlUrl, 'Previous', { InstanceID: '0' });
  }

  async setVolume(deviceId: string, volume: number): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.sendRenderingAction(device, 'SetVolume', {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: String(Math.round(volume)),
    });
  }

  async getVolume(deviceId: string): Promise<number> {
    const device = this.getDevice(deviceId);
    try {
      const result = await this.sendRenderingAction(device, 'GetVolume', {
        InstanceID: '0',
        Channel: 'Master',
      });
      const match = result.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/);
      return match ? parseInt(match[1], 10) : 50;
    } catch {
      return 50;
    }
  }

  async getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus> {
    const device = this.getDevice(deviceId);
    const result = await this.sendAction(device.controlUrl, 'GetTransportInfo', {
      InstanceID: '0',
    });
    const stateMatch = result.match(/<CurrentTransportState>(\w+)<\/CurrentTransportState>/);
    const state = stateMatch?.[1] || 'STOPPED';

    const posResult = await this.sendAction(device.controlUrl, 'GetPositionInfo', {
      InstanceID: '0',
    });
    const posMatch = posResult.match(/<RelTime>([\d:]+)<\/RelTime>/);
    const durMatch = posResult.match(/<TrackDuration>([\d:]+)<\/TrackDuration>/);

    const volume = await this.getVolume(deviceId);

    return {
      state: state === 'PLAYING' ? 'playing' : state === 'PAUSED_PLAYBACK' ? 'paused' : 'stopped',
      position: this.parseTime(posMatch?.[1] || '0:00:00'),
      duration: this.parseTime(durMatch?.[1] || '0:00:00'),
      volume,
      trackUri: parseTrackUri(posResult),
    };
  }

  private parseTime(time: string): number {
    const parts = time.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  private async sendAction(
    controlUrl: string,
    action: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    // Every argument is text, DIDL-Lite included: escaped exactly once (P04).
    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('');

    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      ${argsXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
      },
      body,
      signal: requestSignal(signal),
    });

    if (!res.ok) throw new Error(`DLNA ${action} failed with HTTP ${res.status}`);

    return res.text();
  }

  private async sendRenderingAction(
    device: DlnaDevice,
    action: string,
    args: Record<string, string>,
  ): Promise<string> {
    // Derive RenderingControl URL from AVTransport URL
    const renderUrl = device.controlUrl.replace(/AVTransport/gi, 'RenderingControl');

    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('');

    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      ${argsXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

    const res = await fetch(renderUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"urn:schemas-upnp-org:service:RenderingControl:1#${action}"`,
      },
      body,
      signal: requestSignal(),
    });

    return res.text();
  }

  /** DLNA renderers want a protocolInfo; MP3 is the guess when nobody said. */
  private didlFor(uri: string, meta?: TrackMetadata): string {
    return buildDidlLite(uri, meta, mimeTypeOf(meta) ?? 'audio/mpeg');
  }
}
