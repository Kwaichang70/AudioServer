import ssdp from 'node-ssdp';
const { Client: SsdpClient } = ssdp;
import xml2js from 'xml2js';
const { parseStringPromise } = xml2js;
import { logger } from '../logger.js';
import type { DeviceController, OutputDevice, DevicePlaybackStatus, TrackMetadata } from '@audioserver/shared';

interface SonosDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
}

/**
 * Sonos controller using UPnP/SOAP (same protocol, Sonos-specific discovery).
 * Works with Sonos speakers and IKEA Symfonisk (which run Sonos firmware).
 */
export class SonosController implements DeviceController {
  readonly deviceType = 'sonos' as const;
  private devices = new Map<string, SonosDevice>();

  async discover(): Promise<OutputDevice[]> {
    this.devices.clear();

    return new Promise((resolve) => {
      const client = new SsdpClient();

      client.on('response', async (headers) => {
        if (!headers.LOCATION) return;
        // Sonos devices identify with "Sonos" in their server header
        const server = String(headers.SERVER || '');
        if (!server.includes('Sonos') && !String(headers.LOCATION).includes(':1400/')) return;

        try {
          await this.parseSonosDevice(headers.LOCATION);
        } catch {
          // Not a Sonos device
        }
      });

      // Search for ZonePlayer (Sonos-specific) and generic MediaRenderer
      client.search('urn:schemas-upnp-org:device:ZonePlayer:1');

      setTimeout(() => {
        client.stop();
        resolve(this.getDeviceList());
      }, 5000);
    });
  }

  private async parseSonosDevice(location: string): Promise<void> {
    const res = await fetch(location);
    const xml = await res.text();
    const parsed = await parseStringPromise(xml);

    const device = parsed?.root?.device?.[0];
    if (!device) return;

    const name = device.roomName?.[0] || device.friendlyName?.[0] || 'Sonos';
    const udn = device.UDN?.[0] || '';
    const modelName = device.modelName?.[0] || '';

    // Only Sonos/Symfonisk devices
    if (!modelName.includes('Sonos') && !modelName.includes('SYMFONISK') && !name.includes('Sonos')) {
      return;
    }

    const url = new URL(location);
    const id = udn.replace('uuid:', '') || `sonos-${url.hostname}`;

    this.devices.set(id, {
      id,
      name: `${name} (${modelName})`,
      host: url.hostname,
      port: parseInt(url.port) || 1400,
      isOnline: true,
    });

    logger.info(`Sonos found: ${name} (${modelName}) at ${url.hostname}`);
  }

  private getDeviceList(): OutputDevice[] {
    return Array.from(this.devices.values()).map((d) => ({
      id: d.id,
      name: d.name,
      type: 'sonos' as const,
      host: d.host,
      isOnline: d.isOnline,
    }));
  }

  private getDevice(deviceId: string): SonosDevice {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Sonos device not found: ${deviceId}`);
    return device;
  }

  private baseUrl(device: SonosDevice): string {
    return `http://${device.host}:${device.port}`;
  }

  async play(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void> {
    const device = this.getDevice(deviceId);
    const base = this.baseUrl(device);

    // Set URI
    await this.soapAction(base, 'AVTransport', 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: streamUrl,
      CurrentURIMetaData: metadata ? this.buildDidl(streamUrl, metadata) : '',
    });

    // Play
    await this.soapAction(base, 'AVTransport', 'Play', {
      InstanceID: '0',
      Speed: '1',
    });
  }

  async pause(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.soapAction(this.baseUrl(device), 'AVTransport', 'Pause', { InstanceID: '0' });
  }

  async resume(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.soapAction(this.baseUrl(device), 'AVTransport', 'Play', { InstanceID: '0', Speed: '1' });
  }

  async stop(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.soapAction(this.baseUrl(device), 'AVTransport', 'Stop', { InstanceID: '0' });
  }

  async next(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.soapAction(this.baseUrl(device), 'AVTransport', 'Next', { InstanceID: '0' });
  }

  async previous(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.soapAction(this.baseUrl(device), 'AVTransport', 'Previous', { InstanceID: '0' });
  }

  async setVolume(deviceId: string, volume: number): Promise<void> {
    const device = this.getDevice(deviceId);
    await this.soapAction(this.baseUrl(device), 'RenderingControl', 'SetVolume', {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: String(Math.round(volume)),
    });
  }

  async getVolume(deviceId: string): Promise<number> {
    const device = this.getDevice(deviceId);
    try {
      const result = await this.soapAction(this.baseUrl(device), 'RenderingControl', 'GetVolume', {
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
    const base = this.baseUrl(device);
    try {
      const info = await this.soapAction(base, 'AVTransport', 'GetTransportInfo', { InstanceID: '0' });
      const stateMatch = info.match(/<CurrentTransportState>(\w+)<\/CurrentTransportState>/);
      const state = stateMatch?.[1] || 'STOPPED';

      const pos = await this.soapAction(base, 'AVTransport', 'GetPositionInfo', { InstanceID: '0' });
      const posMatch = pos.match(/<RelTime>([\d:]+)<\/RelTime>/);
      const durMatch = pos.match(/<TrackDuration>([\d:]+)<\/TrackDuration>/);

      const volume = await this.getVolume(deviceId);

      return {
        state: state === 'PLAYING' ? 'playing' : state === 'PAUSED_PLAYBACK' ? 'paused' : 'stopped',
        position: this.parseTime(posMatch?.[1] || '0:00:00'),
        duration: this.parseTime(durMatch?.[1] || '0:00:00'),
        volume,
      };
    } catch {
      return { state: 'stopped', position: 0, duration: 0, volume: 50 };
    }
  }

  private parseTime(time: string): number {
    const parts = time.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  private async soapAction(baseUrl: string, service: string, action: string, args: Record<string, string>): Promise<string> {
    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${this.escapeXml(v)}</${k}>`)
      .join('');

    const serviceUrn = `urn:schemas-upnp-org:service:${service}:1`;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceUrn}">
      ${argsXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

    const controlPath = service === 'AVTransport'
      ? '/MediaRenderer/AVTransport/Control'
      : '/MediaRenderer/RenderingControl/Control';

    const res = await fetch(`${baseUrl}${controlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${serviceUrn}#${action}"`,
      },
      body,
    });

    return res.text();
  }

  private buildDidl(uri: string, meta: TrackMetadata): string {
    return `&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot; xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot;&gt;&lt;item&gt;&lt;dc:title&gt;${this.escapeXml(meta.title)}&lt;/dc:title&gt;&lt;upnp:artist&gt;${this.escapeXml(meta.artist)}&lt;/upnp:artist&gt;&lt;upnp:album&gt;${this.escapeXml(meta.album)}&lt;/upnp:album&gt;&lt;res&gt;${this.escapeXml(uri)}&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`;
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
