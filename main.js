'use strict';

const HospitalService = require('./lib/services/hospital.service');
const VaccinationService = require('./lib/services/vaccination.service');

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const {default: axios} = require('axios');
const adapterName = require('./package.json').name.split('.').pop();
const stateAttr = require('./lib/stateAttr.js'); // State attribute definitions
const {wait} = require('./lib/tools');
const countryJs = require('country-list-js');
const allCountrys = []; // Array for all countrys to store in object
const warnMessages = {};
// For Germany, arrays to store federal states, city and  counties to store in object
let allGermanyFederalStates = [], allGermanCountyDetails = [], allGermanyCounties = [], allGermanyCities = [];
let allGermanyFederalStatesLoaded = null, allGermanyCountiesLoaded = null, allGermanyCitiesLoaded = null;
let vaccinationData$;
let germanHospitalData$;

// Translator if country names are not iso conform
const countryTranslator = require('./lib/countryTranslator');
const {allSpaces, allPointAndCommas, modifyFloatRegex, americaRegex} = require('./lib/regex');

class Covid19 extends utils.Adapter {
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		// @ts-ignore
		super({
			...options,
			name: adapterName || 'coronavirus-statistics',
		});
		this.on('ready', this.onReady.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		try {
			// Load configuration
			const selectedCountries = this.config.countries || [];
			const selectedGermanyFederalStates = this.config.selectedGermanyFederalStates || [];
			const selectedGermanyCities = this.config.selectedGermanyCities || [];
			const selectedGermanyCounties = this.config.selectedGermanyCounties || [];
			this.log.debug(`Configuration object before config load : ${JSON.stringify(this.config)}`);

			// Determine if routine must run to get data for tables
			const loadedArrays = await this.getObjectAsync(`${this.namespace}.countryTranslator`);
			if (!loadedArrays) {
				allGermanyCitiesLoaded = false;

			} else {
				allGermanyCitiesLoaded = loadedArrays.native.allGermanyCities || false;
				allGermanyCountiesLoaded = loadedArrays.native.allGermanyCounties || false;
				allGermanyFederalStatesLoaded = loadedArrays.native.allGermanyFederalStates || false;
			}

			const loadAll = async () => {
				// Try to call API and get global information
				let apiResult = null;
				try {
					// Try to reach API and receive data
					apiResult = await axios.get('https://disease.sh/v3/covid-19/all');
				} catch (error) {
					this.log.warn(`[loadAll] Unable to contact COVID-19 API : ${error}`);
					return;
				}
				this.log.debug(`Data from COVID-19 API received : ${apiResult.data}`);
				const values = apiResult.data;
				await this.extendObjectAsync(`global_totals`, {
					type: 'device',
					common: {
						name: 'Total values of all countries togehter',
					},
					native: {},
				});
				for (const i of Object.keys(values)) {
					await this.localCreateState(`global_totals.${i}`, i, values[i]);
				}
			};

			const loadCountries = async () => {
				try {
					let apiResult = null;
					const continentsStats = {};
					continentsStats['America'] = {};
					continentsStats['World_Sum'] = {};

					// Try to call API and get country information
					try {
						apiResult = await axios.get('https://disease.sh/v3/covid-19/countries?sort=cases')
							.then(response => response.data);
						this.log.debug(`Data from COVID-19 API received : ${JSON.stringify(apiResult)}`);
						this.log.debug(`load all country's : ${this.config.loadAllCountrys} as ${typeof this.config.loadAllCountrys}`);
					} catch (error) {
						this.log.warn(`[loadCountries] Unable to contact COVID-19 API : ${error}`);
						return;
					}

					// Write all country states depending on filter
					for (const countryData of apiResult) {
						if (!countryData.country) continue;

						let countryName = countryData.country;
						let continentName = this.characterReplace(countryData.continent);

						const countryObject = this.getCountryObject(countryData.country, countryData['countryInfo']);

						// if set use iso country values
						if (countryObject) {
							if (countryObject.name) {
								countryName = countryObject.name;
							}
							if (countryObject.continent) {
								continentName = this.characterReplace(countryObject.continent);
							}
						}


						allCountrys.push(countryName);
						const country = this.characterReplace(countryName);

						this.log.debug(`api name: ${countryData.country}, converted name: ${countryName}, dp name: ${country}, continent: ${continentName}`);

						const countryIsChecked = this.config.loadAllCountrys || selectedCountries.includes(countryName);

						// Only write values if country is selected
						if (countryIsChecked) {
							try {
								await this.createFolderStructure(country);
								await this.writeVaccinationDataForCountry(country, await VaccinationService.getVaccinationDataByIsoCode(vaccinationData$, countryObject.code.iso3));
								if (country === 'Germany') {
									await this.writeHospitalDataForId(country, await HospitalService.getGermanOverallHospitalData(germanHospitalData$));
								}
							} catch (error) {
								this.log.debug(`Cannot write data for ${country}: ${error}`);
							}
						} else {
							if (this.config.deleteUnused === true) {
								await this.localDeleteState(country)
									.catch(() => void 0); // ignore error
							}
						}

						await this.localDeleteState(`${country}.countryInfo`);

						if (!continentName) continue;

						continentsStats[continentName] = continentsStats[continentName] || {};
						continentsStats[continentName]['countries'] = continentsStats[continentName]['countries'] || []; // collect all countries of continent
						continentsStats[continentName]['inhabitants'] = continentsStats[continentName]['inhabitants'] || 0; // inhabitants to calculate relative values
						continentsStats['America']['countries'] = continentsStats['America']['countries'] || [];
						continentsStats['America']['inhabitants'] = continentsStats['America']['inhabitants'] || 0;
						continentsStats['World_Sum']['inhabitants'] = continentsStats['World_Sum']['inhabitants'] || 0;

						continentsStats[continentName]['countries'].push(countryName);
						continentsStats[continentName]['inhabitants'] = continentsStats[continentName]['inhabitants'] + (countryData['cases'] / countryData['casesPerOneMillion']);
						continentsStats['World_Sum']['inhabitants'] = continentsStats['World_Sum']['inhabitants'] + (countryData['cases'] / countryData['casesPerOneMillion']);

						if (continentName && continentName.match(americaRegex)) {
							continentsStats['America']['countries'].push(countryName);
							continentsStats['America']['inhabitants'] = continentsStats['America']['inhabitants'] + (countryData['cases'] / countryData['casesPerOneMillion']);
						}

						// Write states for all country's in API
						for (const property of Object.keys(countryData)) {
							// Don't create a state for the country
							if (property === 'country') continue;

							if (countryIsChecked) {
								if (property !== 'countryInfo') {
									await this.localCreateState(`${country}.${property}`, property, countryData[property]);
									this.log.debug(`${country} written`);
								} else {
									// Only take the flag from country info
									await this.localCreateState(`${country}.flag`, 'flag', countryData[property].flag);
								}
							}

							if (property === 'countryInfo') continue;
							continentsStats[continentName][property] = continentsStats[continentName][property] || 0;
							continentsStats['America'][property] = continentsStats['America'][property] || 0;
							continentsStats['World_Sum'][property] = continentsStats['World_Sum'][property] || 0;

							switch (property) {
								case 'continent':
									continentsStats[continentName][property] = countryData[property];
									break;

								case 'updated':
									// for continents: updated is newest of all included countries
									if (countryData[property] > continentsStats[continentName][property]) {
										continentsStats[continentName][property] = countryData[property];
										continentsStats['World_Sum'][property] = countryData[property];
									}
									if (continentName.match(americaRegex)) {
										if (countryData[property] > continentsStats['America'][property]) {
											continentsStats['America'][property] = countryData[property];
										}
									}
									break;

								default:
									continentsStats[continentName][property] += countryData[property];
									continentsStats['World_Sum'][property] += countryData[property];
									if (continentName === 'North_America' || continentName === 'South_America') {
										continentsStats['America'][property] += countryData[property];
									}
							}
						}
					}

					await this.extendObjectAsync(`country_Top_5`, {
						type: 'device',
						common: {
							name: 'country Top 5',
						},
						native: {},
					});

					// Write Top 5
					this.log.debug(`Top 5 Countries : ${JSON.stringify(apiResult.slice(0, 5))}`);
					for (let position = 1; position <= 5; position++) {
						const dataset = apiResult[position - 1]; // start at 0
						let country = dataset.country;

						const channelName = `country_Top_5.${position}`;

						await this.extendObjectAsync(channelName, {
							type: 'channel',
							common: {
								name: `Rank ${position} : ${country}`,
							},
							native: {},
						});

						country = this.characterReplace(country);
						this.log.debug(`Country loop rank : ${position} ${JSON.stringify(country)}`);
						for (const property of Object.keys(dataset)) {
							if (property !== 'countryInfo') {
								await this.localCreateState(`${channelName}.${property}`, property, dataset[property]);
							} else {
								// Only take the flag from country info
								await this.localCreateState(`${channelName}.flag`, 'flag', dataset[property].flag);
							}
						}
					}

					if (this.config.getContinents) {
						// Write continent information
						await this.extendObjectAsync(`global_continents`, {
							type: 'device',
							common: {
								name: 'Global totals for each continent',
							},
							native: {},
						});
					} else {
						await this.localDeleteState('global_continents');
					}

					for (const continentsStatsKey in continentsStats) {
						this.log.debug(`${continentsStatsKey}: ${JSON.stringify(continentsStats[continentsStatsKey])}`);

						await this.setObjectNotExistsAsync(`global_continents.${continentsStatsKey}`, {
							type: 'channel',
							common: {
								name: continentsStatsKey,
							},
							native: {},
						});

						for (const val in continentsStats[continentsStatsKey]) {
							if (val === 'countryInfo') await this.localDeleteState(`global_continents.${continentsStatsKey}.${val}`);
							if ((continentsStats[continentsStatsKey].hasOwnProperty(val)
								&& val !== 'countryInfo'
								&& val !== 'inhabitants'
								&& this.config.getContinents === true)) {
								if (val !== 'countries' && val !== 'casesPerOneMillion' && val !== 'deathsPerOneMillion') {
									await this.localCreateState(`global_continents.${continentsStatsKey}.${val}`, val, continentsStats[continentsStatsKey][val]);
								} else if (val === 'casesPerOneMillion') {
									await this.localCreateState(`global_continents.${continentsStatsKey}.${val}`, val, (continentsStats[continentsStatsKey]['cases'] / continentsStats[continentsStatsKey]['inhabitants']).toFixed(2));
								} else if (val === 'deathsPerOneMillion') {
									await this.localCreateState(`global_continents.${continentsStatsKey}.${val}`, val, (continentsStats[continentsStatsKey]['deaths'] / continentsStats[continentsStatsKey]['inhabitants']).toFixed(2));
								} else {
									await this.localCreateState(`global_continents.${continentsStatsKey}.${val}`, val, continentsStats[continentsStatsKey][val].join());
								}
							} else if ((continentsStats[continentsStatsKey].hasOwnProperty(val) && val !== 'countryInfo')
								&& this.config.getContinents === false) {
								await this.localDeleteState(`global_continents.${continentsStatsKey}.${val}`);
							}
						}
					}

					// add user defined country translation to countryTranslator
					await this.addUserCountriesTranslator();

					await this.extendObjectAsync('countryTranslator', {
						native: {
							allCountrys,
						},
					});

				} catch (error) {
					this.errorHandling('loadCountries', error);
				}
			};

			const germanyBundesland = async () => {
				// Try to call API and get global information
				try {
					// RKI Corona Bundesländer : https://npgeo-corona-npgeo-de.hub.arcgis.com/datasets/ef4b445a53c1406892257fe63129a8ea_0/geoservice?geometry=-23.491%2C46.270%2C39.746%2C55.886
					// DataSource too build query https://npgeo-corona-npgeo-de.hub.arcgis.com/datasets/ef4b445a53c1406892257fe63129a8ea_0?geometry=-23.491%2C46.270%2C39.746%2C55.886
					// const result = await request('https://services7.arcgis.com/mOBPykOjAyBO2ZKk/arcgis/rest/services/Coronaf%C3%A4lle_in_den_Bundesl%C3%A4ndern/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&outSR=4326&f=json');

					// Try to call API and get germanyBundesland
					let apiResult = null;
					try {
						apiResult = await axios.get('https://services7.arcgis.com/mOBPykOjAyBO2ZKk/arcgis/rest/services/Coronaf%C3%A4lle_in_den_Bundesl%C3%A4ndern/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&outSR=4326&f=json')
							.then(response => response.data);
						this.log.debug(`Data from RKI Corona Bundesländer API received : ${JSON.stringify(apiResult)}`);
						this.log.debug(`load all country's : ${this.config.loadAllCountrys} as ${typeof this.config.loadAllCountrys}`);
					} catch (error) {
						this.log.warn(`[germanyBundesland] Unable to contact Corona Bundesländer API : ${error}`);
						return;
					}

					// Cancel operation in case wrong information is received
					if (!apiResult || typeof apiResult !== 'object' || !apiResult.features) {
						this.log.warn(`Incorrect data received from API Corona Bundesländer, values not updated`);
						return;
					}

					// Get Vaccination Data from api.corona-zahlen.org/
					let vaccDataGermany = null;
					try {
						vaccDataGermany = await axios.get('https://api.corona-zahlen.org/vaccinations')
							.then(response => response.data);
						this.log.debug(`Data from api.corona-zahlen.org received : ${vaccDataGermany}`);
					} catch (error) {
						this.log.warn(`[germanyBundesland] Unable to contact api.corona-zahlen.org : ${error}`);
					}

					// Cancel operation in case wrong information is received
					if (!vaccDataGermany || typeof vaccDataGermany !== 'object' || !vaccDataGermany.data || !vaccDataGermany.data.states) {
						this.log.warn(`Incorrect data received from api.corona-zahlen.org received, values not updated`);
						return;
					}

					const germanyVaccinationData = {};
					// Structure API result to workable format

					for (const vaccStates in vaccDataGermany.data.states) {
						germanyVaccinationData[vaccDataGermany.data.states[vaccStates].name] = {
							'allVacc': vaccDataGermany.data.states[vaccStates].administeredVaccinations,
							'firstVacc': vaccDataGermany.data.states[vaccStates].vaccinated,
							'secondVacc': vaccDataGermany.data.states[vaccStates].secondVaccination.vaccinated,
							'firstVaccQuote': vaccDataGermany.data.states[vaccStates].quote * 100,
							'secondVaccQuote': vaccDataGermany.data.states[vaccStates].secondVaccination.quote * 100,
						};
					}

					for (const feature of apiResult.features) {
						this.log.debug(`Getting data for Federal State : ${JSON.stringify(feature.attributes.LAN_ew_GEN)}`);
						const federalStateName = feature.attributes.LAN_ew_GEN;
						const channelName = `Germany.Bundesland.${federalStateName}`;
						allGermanyFederalStates.push(federalStateName);

						//ToDo: clean
						// Delete unused states of previous excel data
						await this.localDeleteState(`${channelName}._Impfungen.rkiImpfungenProTausend`);
						await this.localDeleteState(`${channelName}._Impfungen.rkiDifferenzVortag`);
						await this.localDeleteState(`${channelName}._Impfungen.rkiIndikationAlter`);
						await this.localDeleteState(`${channelName}._Impfungen.rkiIndikationBeruf`);
						await this.localDeleteState(`${channelName}._Impfungen.rkiIndikationMedizinisch`);
						await this.localDeleteState(`${channelName}._Impfungen.rkiImpfungePflegeheim`);

						if (this.config.getAllGermanyFederalStates || selectedGermanyFederalStates.includes(federalStateName)) {

							// Create Channel for each Federal State
							await this.extendObjectAsync(channelName, {
								type: 'channel',
								common: {
									name: federalStateName,
								},
								native: {},
							});

							try {
								await this.writeHospitalDataForId(channelName, await HospitalService.getGermanHospitalDataByFederalState(germanHospitalData$, federalStateName));
								// Create hospital channel for each Federal State
								await this.extendObjectAsync(`${channelName}.Hospital`, {
									type: 'channel',
									common: {
										name: `Hospital`,
									},
									native: {},
								});
							} catch (error) {
								this.log.error(`Cannot write hospital data for ${channelName}: ${error}`);
							}

							if (vaccDataGermany != null) {
								if (germanyVaccinationData[federalStateName]) {
									await this.extendObjectAsync(`${channelName}._Impfungen`, {
										type: 'channel',
										common: {
											name: `Impfungen data by RKI`,
										},
										native: {},
									});

									// Handle vaccination data based new Excel layout
									await this.localCreateState(`${channelName}._Impfungen.rkiImpfungenGesamtVerabreicht`, 'Gesamtzahl bisher verabreichter Impfungen', germanyVaccinationData[federalStateName].allVacc);
									await this.localCreateState(`${channelName}._Impfungen.rkiErstimpfungenKumulativ`, 'Erstimpfungen Kumulativ', germanyVaccinationData[federalStateName].firstVacc);
									await this.localCreateState(`${channelName}._Impfungen.rkiZweitimpfungenKumulativ`, 'Zweitimpfungen Kumulativ', germanyVaccinationData[federalStateName].secondVacc);
									await this.localCreateState(`${channelName}._Impfungen.rkiErstimpfungenImpfquote`, 'Erstimpfungen Impfquote', await this.modify(`round(2)`, germanyVaccinationData[federalStateName].firstVaccQuote));
									await this.localCreateState(`${channelName}._Impfungen.rkiZweitimpfungenImpfquote`, 'Zweitimpfungen Impfquote', await this.modify(`round(2)`, germanyVaccinationData[federalStateName].secondVaccQuote));

									// Delete unused states from previous RKI version
									await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenBioNTech`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenModerna`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenAstraZeneca`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenDifferenzVortag`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenKumulativ`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenBioNTech`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenModerna`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenAstraZeneca`);
									await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenDifferenzVortag`);

								}
							}

							for (const attributeName of Object.keys(feature.attributes)) {

								switch (attributeName) {
									case 'Aktualisierung': 		//  Last refresh date
										await this.localCreateState(`${channelName}.updated`, 'updated', feature.attributes[attributeName]);
										break;

									case 'Death':				// Current reported deaths
										await this.localCreateState(`${channelName}.deaths`, 'deaths', feature.attributes[attributeName]);
										break;

									case 'Fallzahl':			// Current reported cases
										await this.localCreateState(`${channelName}.cases`, 'cases', feature.attributes[attributeName]);
										break;

									case 'faelle_100000_EW':	// reported cases per 100k
										await this.localCreateState(`${channelName}.cases_per_100k`, 'cases_per_100k', feature.attributes[attributeName]);
										break;

									case 'cases7_bl_per_100k':	// reported cases per 100k during the last 7 days
										await this.localCreateState(`${channelName}.cases7_per_100k`, 'cases7_per_100k', feature.attributes[attributeName]);
										break;

									default:
										this.log.debug(`Data \\"${attributeName}\\" from API ignored having values : ${feature.attributes[attributeName]}`);
								}
							}

						} else {

							for (const attributeName of Object.keys(feature.attributes)) {

								// Delete vaccination states
								await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenKumulativ`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiImpfungenGesamtVerabreicht`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenBioNTech`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenModerna`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenAstraZeneca`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenDifferenzVortag`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiErstimpfungenImpfquote`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenKumulativ`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenBioNTech`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenModerna`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenAstraZeneca`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenDifferenzVortag`);
								await this.localDeleteState(`${channelName}._Impfungen.rkiZweitimpfungenImpfquote`);

								switch (attributeName) {
									case 'Aktualisierung': 	//  Last refresh date
										await this.localDeleteState(`${channelName}.updated`);
										break;

									case 'Death':		// Current reportet deaths
										await this.localDeleteState(`${channelName}.deaths`);
										break;

									case 'Fallzahl':		// Current reportet cases
										await this.localDeleteState(`${channelName}.cases`);
										break;

									case 'faelle_100000_EW':	// reported cases per 100k
										await this.localDeleteState(`${channelName}.cases_per_100k`);
										break;

									case 'cases7_bl_per_100k':	// reported cases per 100k during the last 7 days
										await this.localDeleteState(`${channelName}.cases7_per_100k`);
										break;

									default:
										this.log.debug(`Data \\"${attributeName}\\" from API ignored having values : ${feature.attributes[attributeName]}`);
										await this.localDeleteState(`${channelName}.${attributeName}`);
								}
							}
						}
					}

					await this.localDeleteState(`Germany._Impfungen`);

					allGermanyFederalStates = allGermanyFederalStates.sort();
					this.log.debug(`allGermanyFederalStates : ${JSON.stringify(allGermanyFederalStates)}`);

					await this.extendObjectAsync('countryTranslator', {
						native: {
							allGermanyFederalStates,
						},
					});

				} catch (error) {
					this.errorHandling('germanyFederalStates', error);
				}
			};

			const germanyCounties = async () => {
				// Try to call API and get global information
				try {
					// RKI Corona Landkreise : https://npgeo-corona-npgeo-de.hub.arcgis.com/datasets/917fc37a709542548cc3be077a786c17_0/geoservice?selectedAttribute=BSG

					// Try to call API and get germanyBundesland
					let apiResult = null;
					try {
						apiResult = await axios.get('https://services7.arcgis.com/mOBPykOjAyBO2ZKk/arcgis/rest/services/RKI_Landkreisdaten/FeatureServer/0/query?where=1%3D1&outFields=OBJECTID,GEN,BEZ,death_rate,cases,deaths,cases_per_100k,cases7_per_100k,cases_per_population,BL,county,last_update&returnGeometry=false&outSR=4326&f=json');
						this.log.debug(`Data from RKI Corona Landkreise API received : ${apiResult.data}`);
						this.log.debug(`load all country's : ${this.config.loadAllCountrys} as ${typeof this.config.loadAllCountrys}`);
					} catch (error) {
						this.log.warn(`[germanyBundesland] Unable to contact RKI Corona Bundesländer API : ${error}`);
						return;
					}

					const values = apiResult.data;
					// Cancel operation in case wrong information is received
					if (typeof values !== 'object') {
						this.log.warn(`Incorrect data received from API RKI Corona Bundesländer, values not updated`);
						return;
					}

					for (const feature of values.features) {
						if (!feature) continue;

						this.log.debug(`Getting data for Landkreise : ${JSON.stringify(feature.attributes.county)} containing ${JSON.stringify(feature.attributes)}`);

						let countyName = feature.attributes.GEN;
						let countiesType = feature.attributes.BEZ;
						countyName = this.characterReplace(countyName);
						allGermanCountyDetails.push({
							[feature.attributes.county]: {
								GEN: feature.attributes.GEN,
								county: feature.attributes.county,
								BEZ: feature.attributes.BEZ,
							},
						});

						// Distinguish between Kreisfreie Stadt & Landkreis
						if (countiesType === 'Kreisfreie Stadt') {
							allGermanyCities.push(countyName);
							countiesType = 'Stadt';
						} else if (countiesType === 'Kreis') {
							allGermanyCounties.push(countyName);
							countiesType = 'Kreis';
						} else if (countiesType === 'Landkreis') {
							allGermanyCounties.push(countyName);
							countiesType = 'Kreis';
						} else if (countiesType === 'Stadtkreis') {
							allGermanyCities.push(countyName);
							countiesType = 'Stadt';
						} else if (countiesType === 'Bezirk') {
							allGermanyCities.push(countyName);
							countiesType = 'Stadt';
						} else {
							this.log.error(`Unknown ${countiesType} received containing ${JSON.stringify(feature)}`);
						}

						const folderStructure = async () => {
							await this.extendObjectAsync(`Germany.${countiesType}`, {
								type: 'channel',
								common: {
									name: countiesType,
								},
								native: {},
							});
							// await this.createChannelAsync(`Germany`, countiesType);
							// Create Vaccination Channel
							await this.extendObjectAsync(`Germany.${countiesType}.${countyName}`, {
								type: 'channel',
								common: {
									name: countyName,
								},
								native: {},
							});
						};

						// Create proper folder structure
						if (countiesType == 'Kreis'
							&& (this.config.getAllGermanyCounties || selectedGermanyCounties.includes(countyName))) {
							await folderStructure();

						} else if (countiesType == 'Kreis') {
							await this.localDeleteState(`Germany.${countiesType}.${countyName}`);
						}

						if (countiesType == 'Stadt'
							&& (this.config.getAllGermanyCities || selectedGermanyCities.includes(countyName))) {
							await folderStructure();

						} else if (countiesType == 'Stadt') {
							await this.localDeleteState(`Germany.${countiesType}.${countyName}`);
						}

						// Run truth all states and write information
						for (const attributeName of Object.keys(feature.attributes)) {

							this.log.debug(`Statename will be : Germany.${countiesType}.${countyName} containing ${JSON.stringify(feature.attributes)}`);

							if (attributeName !== 'county' && attributeName !== 'GEN' && attributeName !== 'BEZ' && attributeName !== 'OBJECTID') {

								switch (countiesType) {

									case 'Stadt':

										if (this.config.getAllGermanyCities || selectedGermanyCities.includes(countyName)) {
											this.log.debug(`Create city : ${countyName}`);
											// Create State for each Landkreis
											await this.localCreateState(`Germany.${countiesType}.${countyName}.${attributeName}`, attributeName, feature.attributes[attributeName]);
										}

										break;

									case 'Kreis':

										if (this.config.getAllGermanyCounties || selectedGermanyCounties.includes(countyName)) {
											this.log.debug(`Create Landkreis  : ${countyName}`);
											// Create State for each Landkreis
											await this.localCreateState(`Germany.${countiesType}.${countyName}.${attributeName}`, attributeName, feature.attributes[attributeName]);
										}

										break;

									default:

										await this.localDeleteState(`Germany.county.${countyName}.${attributeName}`);

								}
							}
						}

					}

					allGermanCountyDetails = allGermanCountyDetails.sort();
					this.log.debug(`allGermanCountyDetails : ${JSON.stringify(allGermanCountyDetails)}`);

					allGermanyCities = allGermanyCities.sort();
					this.log.debug(`allGermanyCities : ${JSON.stringify(allGermanyCities)}`);

					allGermanyCounties = allGermanyCounties.sort();
					this.log.debug(`allGermanyCounties : ${JSON.stringify(allGermanyCounties)}`);

					await this.extendObjectAsync('countryTranslator', {
						native: {
							allGermanyCounties,
						},
					});

					await this.extendObjectAsync('countryTranslator', {
						native: {
							allGermanyCities,
						},
					});

				} catch (error) {
					this.errorHandling('germanyCounties', error);
				}
			};

			// Random number generator to avoid all ioBroker instances calling the API at the same time
			await wait(Math.floor(Math.random() * 30 * 1000));

			vaccinationData$ = VaccinationService.refreshVaccinationData()
				.catch(error => this.log.warn(`Vaccination Data Warning: ${error}`));		// load all vaccination data
			germanHospitalData$ = HospitalService.refreshGermanHospitalData()
				.catch(error => this.log.warn(`Hospital Data Warning: ${error}`));			// load german hospital data
			await loadAll();																// Global Worldwide statistics
			await loadCountries(); 															// Detailed Worldwide statistics by country

			if (this.config.getGermanyFederalStates || !allGermanyFederalStatesLoaded) {
				await this.extendObjectAsync(`Germany.Bundesland`, {
					type: 'channel',
					common: {
						name: 'Bundesland',
					},
					native: {},
				});
				await germanyBundesland(); // Detailed Federal state statistics for germany
			} else {
				await this.localDeleteState(`Germany.Bundesland`);
			}

			// Get data for cities and counties of Germany, ensure tables always have values to load
			if (this.config.getGermanyCities || this.config.getGermanyCounties || !allGermanyCitiesLoaded || !allGermanyCountiesLoaded) {
				await germanyCounties(); // Detailed city state statistics for germany
			}

			// Delete potential unused data for germany
			if (!this.config.getGermanyCities) {
				await this.localDeleteState(`Germany.Stadt`);
			}

			if (!this.config.getGermanyCounties) {
				await this.localDeleteState(`Germany.Kreis`);
			}

			// Always terminate at the end
			this.terminate ? this.terminate('All data handled, adapter stopped until next scheduled moment') : process.exit();

		} catch (error) {
			this.errorHandling('onReady', error);

			// Ensure termination at error
			this.terminate ? this.terminate('Adapter closed unexpectedly, not all data processed') : process.exit();
		}
	}

	async localCreateState(state, name, value) {
		this.log.debug(`Create_state called for : ${state} with value : ${value}`);

		try {
			// Try to get details from state lib, if not use defaults. throw warning if states is not known in attribute list
			if (stateAttr[name] === undefined) {
				const warnMessage = `State attribute definition missing for ${name}`;
				if (warnMessages[name] !== warnMessage) {
					warnMessages[name] = warnMessage;
					this.log.warn(`State attribute definition missing for ${name}`);
				}
			}
			const writable = stateAttr[name] !== undefined ? stateAttr[name].write || false : false;
			const state_name = stateAttr[name] !== undefined ? stateAttr[name].name || name : name;
			const role = stateAttr[name] !== undefined ? stateAttr[name].role || 'state' : 'state';
			const type = typeof (value);
			const unit = stateAttr[name] !== undefined ? stateAttr[name].unit || '' : '';
			this.log.debug(`Write value : ${writable}`);

			await this.setObjectNotExistsAsync(state, {
				type: 'state',
				common: {
					name: state_name,
					role: role,
					type: type,
					unit: unit,
					read: true,
					write: writable,
				},
				native: {},
			});

			// Ensure attribute changes are propagated
			await this.extendObjectAsync(state, {
				type: 'state',
				common: {
					name: state_name,
					type: type,
					unit: unit,
				},
			});

			// Only set value if input != null
			if (value !== null) {
				await this.setState(state, {val: value, ack: true});
			}

			// Subscribe on state changes if writable
			// writable && this.subscribeStates(state);
		} catch (error) {
			this.errorHandling('localCreateState', error);
		}
	}

	async localDeleteState(state) {
		try {
			if (this.config.deleteUnused === true) {
				const obj = await this.getObjectAsync(state);
				if (obj) {
					await this.delObjectAsync(state, {recursive: true});
				}
			}
		} catch (error) {
			// do nothing
		}
	}

	/**
	 * @param {string} country
	 * @param {Object} countryInfo
	 */
	getCountryObject(country, countryInfo) {
		try {
			let countryObj = undefined;

			if (countryInfo.iso3) {
				// Country Objekt über iso3 suchen
				return countryJs.findByIso3(countryInfo.iso3);
			}

			if (countryInfo.iso2) {
				// Country Objekt über iso2 suchen
				return countryJs.findByIso2(countryInfo.iso2);
			}

			// kein iso info vorhanden, über Name suchen
			countryObj = countryJs.findByName(country.replace(/_/g, ' ').replace(/é/g, 'e').replace(/ç/g, 'c'));

			if (countryObj && countryObj.continent) {
				return countryObj;
			}

			countryObj = countryJs.findByName(countryTranslator[country]);

			if (countryObj && countryObj.continent) {
				return countryObj;
			}

			if (country !== 'Diamond Princess' && country !== 'MS Zaandam') {
				this.log.warn(`${country} (iso2: ${countryInfo.iso2}, iso3: ${countryInfo.iso3}) not found in lib! Must be added to the country name translator.`);
			}

		} catch (error) {
			this.errorHandling('getIsoCountry', error);
		}

		return undefined;
	}

	async addUserCountriesTranslator() {
		try {
			const userCountryTranslator = await this.getStateAsync('countryTranslator');
			if (userCountryTranslator && userCountryTranslator.val) {
				// add user defined country translation to countryTranslator
				try {
					const userCountries = JSON.parse(userCountryTranslator.val);
					Object.keys(userCountries).forEach(countryId => {
						if (!countryTranslator.hasOwnProperty(countryId)) {
							countryTranslator[countryId] = userCountries[countryId];
							this.log.info(`user defined country translation added: ${countryId} -> ${userCountries[countryId]}`);
						}
					});
				} catch (parseError) {
					this.log.error(`Can not parse json string for user defined country translation! Check input of datapoint '.countryTranslator'. error: ${parseError.message}`);
				}
			}
		} catch (error) {
			this.errorHandling('addUserCountriesTranslator', error);
		}
	}

	characterReplace(inputString) {
		if (!inputString) return;
		return inputString.replace(allSpaces, '_').replace(allPointAndCommas, '');
	}

	/**
	 * writes vaccination data to folder of country
	 *
	 * @param country				"Germany"
	 * @param data					Object to write
	 */
	async writeVaccinationDataForCountry(country, data) {
		if (data) {
			for (const key of Object.keys(data)) {
				await this.localCreateState(`${country}.Vaccination.${key}`, key, data[key]);
			}
		} else {
			this.log.debug(`Cannot write vaccination data for ${country}, if this error continues please report a bug to the developer! Totals: ${JSON.stringify(data)}`);
		}
	}

	/**
	 * @param id				"Germany"
	 * @param data					Object to write
	 */
	async writeHospitalDataForId(id, data) {
		if (!data) {
			this.log.debug(`Cannot write hospital data for ${id}, if this error continues please report a bug to the developer! Totals: ${JSON.stringify(data)}`);
			return;
		}


		await this.extendObjectAsync(`${id}.Hospital`, {
			type: 'channel',
			common: {
				name: `Hospital`,
			},
			native: {},
		});

		for (const key of Object.keys(data)) {
			await this.localCreateState(`${id}.Hospital.${key}`, key, data[key]);
		}
	}

	async createFolderStructure(country) {

		// Create country folder
		await this.extendObjectAsync(country, {
			type: 'device',
			common: {
				name: country,
			},
			native: {},
		});

		// Create Vaccination Channel
		await this.extendObjectAsync(`${country}.Vaccination`, {
			type: 'channel',
			common: {
				name: 'Vaccination Data',
			},
			native: {},
		});

	}

	/**
	 * Analysis modify element in stateAttr.js and executes command
	 * @param {string} method defines the method to be executed (e.g. round())
	 * @param {string | number | boolean} value value to be executed
	 */
	modify(method, value) {
		this.log.debug(`Function modify with method "${method}" and value "${value}"`);
		let result = null;
		try {
			if (method.match(/^custom:/gi) != null) {                               //check if starts with "custom:"
				value = eval(method.replace(/^custom:/gi, ''));                     //get value without "custom:"
			} else if (method.match(/^multiply\(/gi) != null) {                     //check if starts with "multiply("
				const inBracket = parseFloat(method.match(modifyFloatRegex));    //get value in brackets
				value = value * inBracket;
			} else if (method.match(/^divide\(/gi) != null) {                       //check if starts with "divide("
				const inBracket = parseFloat(method.match(modifyFloatRegex));    //get value in brackets
				value = value / inBracket;
			} else if (method.match(/^round\(/gi) != null) {                        //check if starts with "round("
				const inBracket = parseInt(method.match(modifyFloatRegex));      //get value in brackets
				value = Math.round(value * Math.pow(10, inBracket)) / Math.pow(10, inBracket);
			} else if (method.match(/^add\(/gi) != null) {                          //check if starts with "add("
				const inBracket = parseFloat(method.match(modifyFloatRegex));    //get value in brackets
				value = parseFloat(value) + inBracket;
			} else if (method.match(/^substract\(/gi) != null) {                    //check if starts with "substract("
				const inBracket = parseFloat(method.match(modifyFloatRegex));    //get value in brackets
				value = parseFloat(value) - inBracket;
			} else {
				const methodUC = method.toUpperCase();
				switch (methodUC) {
					case 'UPPERCASE':
						if (typeof value == 'string') result = value.toUpperCase();
						break;
					case 'LOWERCASE':
						if (typeof value == 'string') result = value.toLowerCase();
						break;
					case 'UCFIRST':
						if (typeof value == 'string') result = value.substring(0, 1).toUpperCase() + value.substring(1).toLowerCase();
						break;
					default:
						result = value;
				}
			}
			if (!result) return value;
			return result;
		} catch (e) {
			this.errorHandling(`[modify]`, `${e}`);
			return value;
		}
	}

	errorHandling(codePart, error) {
		this.log.error(`[${codePart}] error: ${error.message}, stack: ${error.stack}`);
		if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
			const sentryInstance = this.getPluginInstance('sentry');
			if (sentryInstance) {
				sentryInstance.getSentryObject().captureException(error);
			}
		}
	}

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Covid19(options);
} else {
	// otherwise start the instance directly
	new Covid19();
}
