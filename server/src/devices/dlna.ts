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

    return new Promise((resolve) => {
      const client = new SsdpClient();
      this.ssdpClient = client;
      const timeout = setTimeout(() => {
        client.stop();
        resolve(this.getDeviceList());
      }, 5000);

      client.on('response', async (headers, _statusCode, rinfo) => {
        if (!headers.LOCATION) return;
        try {
          await this.parseDeviceDescription(headers.LOCATION, rinfo.address);
        } catch (err) {
          // Not a valid MediaRenderer, skip
        }
      });

      // Search for MediaRenderer devices (speakers, streamers, etc.)
      client.search('urn:schemas-upnp-org:device:MediaRenderer:1');

      // Also resolve after timeout
      setTimeout(() => {
        client.stop();
        clearTimeout(timeout);
        resolve(this.getDeviceList());
      }, 5000);
    });
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

    // First set the URI
    await this.sendAction(device.controlUrl, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: streamUrl,
      CurrentURIMetaData: metadata ? this.buildDidlMetadata(streamUrl, metadata) : '',
    });

    // Then play
    await this.sendAction(device.controlUrl, 'Play', {
      InstanceID: '0',
      Speed: '1',
    });
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

  private buildDidlMetadata(uri: string, meta: TrackMetadata): string {
    return `&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;
&lt;item&gt;
&lt;dc:title&gt;${this.escapeXml(meta.title)}&lt;/dc:title&gt;
&lt;upnp:artist&gt;${this.escapeXml(meta.artist)}&lt;/upnp:artist&gt;
&lt;upnp:album&gt;${this.escapeXml(meta.album)}&lt;/upnp:album&gt;
&lt;res&gt;${this.escapeXml(uri)}&lt;/res&gt;
&lt;/item&gt;
&lt;/DIDL-Lite&gt;`;
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
