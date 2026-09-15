import { HomeyAPI } from "homey-api";

export async function connect({ address, token }) {
  return HomeyAPI.createLocalAPI({ address, token, debug: false });
}

export async function getDeviceCount(api) {
  return Object.keys(await api.devices.getDevices()).length;
}
