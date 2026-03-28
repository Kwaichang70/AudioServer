import ssdp from 'node-ssdp';
const { Client: SsdpClient } = ssdp;
import xml2js from 'xml2js';
const { parseStringPromise } = xml2js;
import { logger } from '../logger.js';
import type { DeviceController, OutputDevice, DevicePlaybackStatus, TrackMetadata } from '@audioserver/shared';

interface DlnaDevice {
  id: string;
  name: string;
  host: string;
  controlUrl: string;
  location: string;
  isOnline: boolean;
}

export class DlnaController implements DeviceController {
  readonly deviceType = 'dlna' as const;
  private devices = new Map<string, DlnaDevice>();
  private ssdpClient: InstanceType<typeof SsdpClient> | null = null;

  async discover(): Promise<OutputDevice[]> {
    this.devices.clear();

    // Method 1: SSDP multicast discovery
    await this.ssdpDiscover();

    // Method 2: Direct HTTP probing of known/configured devices
    await this.probeKnownDevices();

    return this.getDeviceList();
  }

  private async ssdpDiscover(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const client = new SsdpClient();
        this.ssdpClient = client;

        client.on('response', async (headers, _statusCode, rinfo) => {
          if (!headers.LOCATION) return;
          try {
            await this.parseDeviceDescription(String(headers.LOCATION), rinfo.address);
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

  private async probeKnownDevices(): Promise<void> {
    // Probe common UPnP ports on known/recently-seen devices
    // Also probe addresses from DLNA_DEVICES env var (comma-separated host:port)
    const probeTargets: string[] = [];

    const envDevices = process.env.DLNA_DEVICES || '';
    if (envDevices) {
      probeTargets.push(...envDevices.split(',').map((s) => s.trim()).filter(Boolean));
    }

    // If no explicit targets, skip probing (user should set DLNA_DEVICES)
    if (probeTargets.length === 0) return;

    await Promise.allSettled(
      probeTargets.map(async (target) => {
        const [host, port] = target.includes(':') ? target.split(':') : [target, '49152'];
        try {
          const descUrl = await this.findDescriptionUrl(host, parseInt(port));
          if (descUrl) {
            await this.parseDeviceDescription(descUrl, host);
          }
        } catch {
          // Device not reachable on this port
        }
      })
    );
  }

  private async findDescriptionUrl(host: string, port: number): Promise<string | null> {
    // Try common UPnP description paths
    const paths = [
      '/',                            // Cocktail Audio, some renderers
      '/xml/device_description.xml', // Sonos
      '/description.xml',            // Generic UPnP
      '/rootDesc.xml',               // Some renderers
      '/DeviceDescription.xml',      // Volumio/MPD
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

  private async parseDeviceDescription(location: string, host: string): Promise<void> {
    try {
      const res = await fetch(location);
      const xml = await res.text();
      const parsed = await parseStringPromise(xml);

      const device = parsed?.root?.device?.[0];
      if (!device) return;

      const friendlyName = device.friendlyName?.[0] || 'Unknown DLNA Device';
      const udn = device.UDN?.[0] || `dlna-${host}`;

      // Find AVTransport service
      let controlUrl = '';
      const services = device.serviceList?.[0]?.service || [];
      for (const svc of services) {
        const serviceType = svc.serviceType?.[0] || '';
        if (serviceType.includes('AVTransport')) {
          controlUrl = svc.controlURL?.[0] || '';
          break;
        }
      }

      // Also check embedded devices (some renderers nest the service)
      if (!controlUrl && device.deviceList?.[0]?.device) {
        for (const embedded of device.deviceList[0].device) {
          const embeddedServices = embedded.serviceList?.[0]?.service || [];
          for (const svc of embeddedServices) {
            if (svc.serviceType?.[0]?.includes('AVTransport')) {
              controlUrl = svc.controlURL?.[0] || '';
              break;
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

      const id = udn.replace('uuid:', '');
      this.devices.set(id, {
        id,
        name: friendlyName,
        host,
        controlUrl: absoluteControlUrl,
        location,
        isOnline: true,
      });

      logger.info(`DLNA device found: ${friendlyName} at ${host} (${absoluteControlUrl})`);
    } catch (err) {
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

  async play(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void> {
    const device = this.getDevice(deviceId);

    // Stop current playback first
    try {
      await this.sendAction(device.controlUrl, 'Stop', { InstanceID: '0' });
    } catch {
      // Ignore stop errors
    }

    // Give device time to release the old stream (Cocktail Audio needs ~1s)
    await new Promise((r) => setTimeout(r, 1000));

    // Set the new URI with proper DIDL-Lite metadata
    const didl = this.buildDidlMetadata(streamUrl, metadata);
    const setResult = await this.sendAction(device.controlUrl, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: streamUrl,
      CurrentURIMetaData: didl,
    });

    if (setResult.includes('Fault')) {
      logger.error(`DLNA SetURI failed for ${device.name}: ${setResult}`);
      throw new Error('Failed to set stream URI on device');
    }

    // Give device time to buffer
    await new Promise((r) => setTimeout(r, 1000));

    // Play with retry — some devices need multiple attempts
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sendAction(device.controlUrl, 'Play', {
        InstanceID: '0',
        Speed: '1',
      });

      // Verify it's actually playing
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const info = await this.sendAction(device.controlUrl, 'GetTransportInfo', { InstanceID: '0' });
        if (info.includes('PLAYING')) {
          logger.info(`DLNA play: ${metadata?.title || 'track'} → ${device.name} (attempt ${attempt + 1})`);
          return;
        }
        logger.warn(`DLNA: device not playing after attempt ${attempt + 1}, retrying...`);
        // Re-send SetURI and Play
        await this.sendAction(device.controlUrl, 'Stop', { InstanceID: '0' });
        await new Promise((r) => setTimeout(r, 1000));
        await this.sendAction(device.controlUrl, 'SetAVTransportURI', {
          InstanceID: '0',
          CurrentURI: streamUrl,
          CurrentURIMetaData: didl,
        });
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        // Continue retrying
      }
    }

    logger.warn(`DLNA play: ${metadata?.title || 'track'} → ${device.name} (may not have started)`);
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
    try {
      const result = await this.sendAction(device.controlUrl, 'GetTransportInfo', { InstanceID: '0' });
      const stateMatch = result.match(/<CurrentTransportState>(\w+)<\/CurrentTransportState>/);
      const state = stateMatch?.[1] || 'STOPPED';

      const posResult = await this.sendAction(device.controlUrl, 'GetPositionInfo', { InstanceID: '0' });
      const posMatch = posResult.match(/<RelTime>([\d:]+)<\/RelTime>/);
      const durMatch = posResult.match(/<TrackDuration>([\d:]+)<\/TrackDuration>/);

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
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  private async sendAction(controlUrl: string, action: string, args: Record<string, string>): Promise<string> {
    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${this.escapeXml(v)}</${k}>`)
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
    });

    return res.text();
  }

  private async sendRenderingAction(device: DlnaDevice, action: string, args: Record<string, string>): Promise<string> {
    // Derive RenderingControl URL from AVTransport URL
    const renderUrl = device.controlUrl.replace(/AVTransport/gi, 'RenderingControl');

    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${this.escapeXml(v)}</${k}>`)
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
    });

    return res.text();
  }

  private buildDidlMetadata(uri: string, meta?: TrackMetadata): string {
    const title = meta?.title || 'Unknown';
    const artist = meta?.artist || 'Unknown';
    const album = meta?.album || 'Unknown';
    const mime = (meta as any)?.mimeType || 'audio/mpeg';
    const coverUrl = (meta as any)?.coverUrl || '';
    const coverTag = coverUrl ? `&lt;upnp:albumArtURI&gt;${this.escapeXml(coverUrl)}&lt;/upnp:albumArtURI&gt;` : '';

    return `&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot; xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot;&gt;&lt;item id=&quot;1&quot; parentID=&quot;0&quot; restricted=&quot;true&quot;&gt;&lt;dc:title&gt;${this.escapeXml(title)}&lt;/dc:title&gt;&lt;dc:creator&gt;${this.escapeXml(artist)}&lt;/dc:creator&gt;&lt;upnp:artist&gt;${this.escapeXml(artist)}&lt;/upnp:artist&gt;&lt;upnp:album&gt;${this.escapeXml(album)}&lt;/upnp:album&gt;${coverTag}&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;&lt;res protocolInfo=&quot;http-get:*:${mime}:*&quot;&gt;${this.escapeXml(uri)}&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`;
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
