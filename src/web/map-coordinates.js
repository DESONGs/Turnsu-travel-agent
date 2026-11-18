const PI = Math.PI;
const EARTH_RADIUS = 6_378_245;
const ECCENTRICITY_SQUARED = 0.006693421622965943;

function outsideMainlandChina(longitude, latitude) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

function latitudeOffset(longitude, latitude) {
  let value = -100 + 2 * longitude + 3 * latitude + 0.2 * latitude * latitude + 0.1 * longitude * latitude + 0.2 * Math.sqrt(Math.abs(longitude));
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3;
  value += (20 * Math.sin(latitude * PI) + 40 * Math.sin(latitude / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(latitude / 12 * PI) + 320 * Math.sin(latitude * PI / 30)) * 2 / 3;
  return value;
}

function longitudeOffset(longitude, latitude) {
  let value = 300 + longitude + 2 * latitude + 0.1 * longitude * longitude + 0.1 * longitude * latitude + 0.1 * Math.sqrt(Math.abs(longitude));
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3;
  value += (20 * Math.sin(longitude * PI) + 40 * Math.sin(longitude / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(longitude / 12 * PI) + 300 * Math.sin(longitude / 30 * PI)) * 2 / 3;
  return value;
}

export function gcj02ToWgs84(longitude, latitude) {
  const numericLongitude = Number(longitude);
  const numericLatitude = Number(latitude);
  if (!Number.isFinite(numericLongitude) || !Number.isFinite(numericLatitude)) return null;
  if (outsideMainlandChina(numericLongitude, numericLatitude)) return { longitude: numericLongitude, latitude: numericLatitude };
  let deltaLatitude = latitudeOffset(numericLongitude - 105, numericLatitude - 35);
  let deltaLongitude = longitudeOffset(numericLongitude - 105, numericLatitude - 35);
  const radianLatitude = numericLatitude / 180 * PI;
  let magic = Math.sin(radianLatitude);
  magic = 1 - ECCENTRICITY_SQUARED * magic * magic;
  const squareRootMagic = Math.sqrt(magic);
  deltaLatitude = deltaLatitude * 180 / ((EARTH_RADIUS * (1 - ECCENTRICITY_SQUARED)) / (magic * squareRootMagic) * PI);
  deltaLongitude = deltaLongitude * 180 / (EARTH_RADIUS / squareRootMagic * Math.cos(radianLatitude) * PI);
  const transformedLatitude = numericLatitude + deltaLatitude;
  const transformedLongitude = numericLongitude + deltaLongitude;
  return { longitude: numericLongitude * 2 - transformedLongitude, latitude: numericLatitude * 2 - transformedLatitude };
}

export function coordinatesForWebMap(coordinates) {
  if (!coordinates || !Number.isFinite(Number(coordinates.longitude)) || !Number.isFinite(Number(coordinates.latitude))) return null;
  if (coordinates.coordinateSystem === "WGS-84") return { longitude: Number(coordinates.longitude), latitude: Number(coordinates.latitude) };
  if (coordinates.coordinateSystem !== "GCJ-02") return null;
  return gcj02ToWgs84(coordinates.longitude, coordinates.latitude);
}
