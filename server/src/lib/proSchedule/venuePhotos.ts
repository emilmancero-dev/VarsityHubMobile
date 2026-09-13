/**
 * Venue photos + attribution for pro-schedule events, sourced from Wikimedia
 * Commons via each venue's Wikidata P18 image (117 venues).
 * Keyed by ProTeam/fixture venue_name. Each entry carries the credit string
 * that MUST be displayed with the image (CC-BY / CC-BY-SA compliance): the
 * pro card + team page render `credit` beneath the photo. Venues without a
 * verified image are omitted and fall back to the team-color gradient.
 * Regenerate: node /tmp/sourceall.mjs (Wikidata + Commons).
 */
export type VenuePhoto = { url: string; credit: string };

export const VENUE_PHOTOS: Record<string, VenuePhoto> = {
  // NCAA (college) venues. Keyed by the venue name ESPN stores as the location's
  // first segment ("Kenan Stadium", not "Kenan Memorial Stadium").
  'Kenan Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Kenan_Memorial_Stadium_2014.jpg',
    credit: 'U.S. Department of State / Wikimedia Commons, public domain',
  },
  'Bridgeforth Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bridgeforth_Stadium_-_James_Madison_University.jpg',
    credit: 'Quintin Soloviev / Wikimedia Commons, CC BY 4.0',
  },
  'Acrisure Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ptr-HeinzField-FILE.jpg',
    credit: 'Fo2grfr / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Allegiant Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Allegiant_Stadium_(cropped).jpg',
    credit: 'Tomás Del Coro / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Amalie Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Amalie_Arena_(cropped).jpg',
    credit: 'Indy beetle / Wikimedia Commons, CC BY-SA 4.0',
  },
  'American Airlines Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/American_Airlines_Center_02.jpg',
    credit: 'Joe Mabel / Wikimedia Commons, CC BY-SA 3.0',
  },
  'American Family Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Miller_Park0001.jpg',
    credit: 'Spaluch1 / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Amway Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Amway_Center_exterior_2023.jpg',
    credit: 'Floydian / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Angel Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Angel_Stadium_of_Anaheim.jpg',
    credit: 'Staff Sgt. Chad McMeen / Wikimedia Commons, Public domain',
  },
  'AT&T Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Arlington_June_2020_4_(AT%26T_Stadium).jpg',
    credit: 'Michael Barera / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Ball Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Denver_Pepsi_Center_1.jpg',
    credit: 'KM Newnham / Wikimedia Commons, CC BY-SA 2.5',
  },
  'Barclays Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/BarclayCenter-2_(48034233762).jpg',
    credit: 'Ajay Suresh from New York, NY, USA / Wikimedia Commons, CC BY 2.0',
  },
  'Bridgestone Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bridgestone_Arena,_Nashville.jpg',
    credit: 'Rhododendrites / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Bank of America Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/BofAStadium2015.JPG',
    credit: 'HangingCurve / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Busch Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Busch_Stadium_III_(16180972535).jpg',
    credit: 'redlegsfan21 / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Caesars Superdome': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mercedes-Benz_Superdome_Poydras_bike.JPG',
    credit: 'Infrogmation of New Orleans / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Capital One Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Verizon_Center_wide.jpg',
    credit: 'Cliff from Arlington, VA (Outside Washington DC), USA / Wikimedia Commons, CC BY 2.0',
  },
  'CareFirst Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Entertainment_and_Sports_Arena_Exterior.jpg',
    credit: 'Gregory Koch / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Chase Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Chase_Center_-_July_2019_(7605).jpg',
    credit: 'Gregory Varnum / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Chase Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Flyover_at_Diamondbacks_season_opener_2010-04-05.JPG',
    credit: 'MSgt. Raheem Moore / Wikimedia Commons, Public domain',
  },
  'Citi Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Citi_Field_Night_Game.jpg',
    credit: 'Chris6d / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Citizens Bank Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Citizens_Bank_Park_2021.jpg',
    credit: 'Chris6d / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Comerica Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Detroit_Tigers_opening_game_at_Comerica_Park%2C_2007.jpg',
    credit: 'User MJCdetroit on en.wikipedia / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Coors Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Coors_field_1.JPG',
    credit: 'Matt Kozlowski / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Crypto.com Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Crypto.com_Arena_exterior_2023.jpg',
    credit: 'Troutfarm27 / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Daikin Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Minute_Maid_Park_2010.JPG',
    credit: 'Delaywaves / Wikimedia Commons, CC BY 3.0',
  },
  'Delta Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Delta_Center_2023.jpg',
    credit: 'Lomrjyo / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Dodger Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Dodger_Stadium.jpg',
    credit: 'Frederick Dennstedt from los angeles, usa / Wikimedia Commons, CC BY-SA 2.0',
  },
  'EagleBank Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/EagleBank_Arena_(George_Mason_University).jpg',
    credit: 'Arturandmandi / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Empower Field at Mile High': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/SAF_at_Mile_High_AFC_Championship_interior.jpg',
    credit: 'Thelastcanadian / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Entertainment and Sports Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Entertainment_and_Sports_Arena_Exterior.jpg',
    credit: 'Gregory Koch / Wikimedia Commons, CC BY-SA 4.0',
  },
  'EverBank Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/EverBank1.jpg',
    credit: 'AndrewAvitus / Wikimedia Commons, CC BY 3.0',
  },
  FedExForum: {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/FedExForum_at_night.jpg',
    credit: 'Marco Espino-Ovalle / Wikimedia Commons, Public domain',
  },
  'Fenway Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/View_of_Fenway_Park_from_the_press_box_in_July_2022.jpg',
    credit: 'Gatorfan252525 / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Fiserv Forum': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Milwaukee_July_2022_022_(Fiserv_Forum).jpg',
    credit: 'Michael Barera / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Ford Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ford-Field-September-10-2006.jpg',
    credit: 'Wikimedia Commons / Wikimedia Commons, CC BY 2.5',
  },
  'Frost Bank Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/AT%26T_Center_at_day.jpg',
    credit: 'Atristan 77 / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Gainbridge Fieldhouse': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/ConsecoFieldhouse.jpg',
    credit: 'Durin at English Wikipedia / Wikimedia Commons, CC BY-SA 3.0',
  },
  'GEHA Field at Arrowhead Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Aerial_view_of_Arrowhead_Stadium_08-31-2013.jpg',
    credit: 'Ichabod / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Gillette Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Gillette_Stadium02.jpg',
    credit: 'Bernard Gagnon / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Globe Life Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/New_Rangers_Ballpark_001.jpg',
    credit: 'Jax 0677 / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Golden 1 Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Allan_000528_171534_516361_4578_(36130546274).jpg',
    credit:
      'Photo by Chris Allan. – U.S. Department of Energy from United States / Wikimedia Commons, Public domain',
  },
  'Great American Ball Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Great_American_Ballpark_2007.jpg',
    credit: 'Eric Kilby profile at Flickr website / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Hard Rock Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Hard_Rock_Stadium_for_Super_Bowl_LIV_(49606707583).jpg',
    credit: 'elisfkc2 / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Highmark Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/New_Highmark_Stadium_construction%2C_2025.webp',
    credit: 'James161723 / Wikimedia Commons, CC0',
  },
  'Huntington Bank Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Cleveland_National_Air_Show_(43805784984).jpg',
    credit: 'Erik Drost / Wikimedia Commons, CC BY 2.0',
  },
  'Intuit Dome': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Intuit_Dome_Fa%C3%A7ade.jpg',
    credit: 'Haruhi8 / Wikimedia Commons, CC BY 4.0',
  },
  'Kaseya Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/American_Airlines_Arena%2C_Miami%2C_FL%2C_jjron_29.03.2012.jpg',
    credit: 'jjron / Wikimedia Commons, GFDL 1.2',
  },
  'Kauffman Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/NewKauffman.jpg',
    credit: 'Mysteryman28 / Wikimedia Commons, Public domain',
  },
  'Kia Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Kia_Center_12-22-24.jpg',
    credit: 'Csab6482 / Wikimedia Commons, CC0',
  },
  'Lambeau Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Lambeau_Field.jpg',
    credit: 'JL1Row / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Lincoln Financial Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Philly_(45).JPG',
    credit: 'The original uploader was Betp at French Wikipedia. / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Little Caesars Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Little_Caesars_Arena_panorama.jpg',
    credit: 'Adam Bishop / Wikimedia Commons, CC BY-SA 4.0',
  },
  'loanDepot park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Marlins_First_Pitch_at_Marlins_Park%2C_April_4%2C_2012.jpg',
    credit: 'Roberto Coquis / Wikimedia Commons, CC BY 2.0',
  },
  'Lucas Oil Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/LucasOilStadiumTheLuke.jpg',
    credit: 'Josh Hallett from Winter Haven, FL, USA / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Lumen Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Qwest_Field_North.jpg',
    credit:
      '"Smart Destinations", GoSeattleCard.com, and Go Seattle Card Blog / Wikimedia Commons, CC BY-SA 2.0',
  },
  'M&T Bank Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/M%26T_Bank_Stadium_DoD.jpg',
    credit: 'United States Department of Defense Cherie Cullen / Wikimedia Commons, Public domain',
  },
  'Madison Square Garden': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Madison_Square_Garden_(MSG)_-_Full_(48124330357).jpg',
    credit: 'Ajay Suresh from New York, NY, USA / Wikimedia Commons, CC BY 2.0',
  },
  'Mercedes-Benz Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mercedes_Benz_Stadium_time_lapse_capture_2017-08-13.jpg',
    credit: 'Atlanta Falcons / Wikimedia Commons, CC BY 3.0',
  },
  'MetLife Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/New_Meadowlands_Stadium_Mezz_Corner.jpg',
    credit: 'babyknight / Wikimedia Commons, CC BY 2.0',
  },
  'Moda Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Moda_Center.JPG',
    credit: 'Lugnuts / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Mohegan Sun Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mohegan_Sun_Arena.jpg',
    credit: 'Bbjeter / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Mortgage Matchup Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Footprint_Center_2022.jpg',
    credit: 'Troutfarm27 / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Nationals Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nationals_Park_Panorama_2011.05.02_-_Washington_Nationals_v_San_Francisco_Giants.jpg',
    credit: 'Something Original (talk) / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Nissan Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/LP_Field_2009_crop.jpg',
    credit: 'Kaldari / Wikimedia Commons, CC0',
  },
  'Northwest Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Commanders_vs_Giants_(53345178211).jpg',
    credit: 'Maryland GovPics / Wikimedia Commons, CC BY 2.0',
  },
  'NRG Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Reliantstadium.jpg',
    credit: 'User eschipul on Flickr / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Oracle Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/The_Oracle%2C_Reading%2C_car_park.jpg',
    credit:
      'Ben Sutherland from Forest Hill, London, European Union / Wikimedia Commons, CC BY 2.0',
  },
  'Oriole Park at Camden Yards': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/OrioleParkAtCamdenYardsJune2013.jpg',
    credit: 'Keith Allison / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Paycom Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Chesapeake_energy_arena_night.JPG',
    credit: 'Urbanative / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Paycor Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Paul_Brown_Stadium_interior_2017.jpg',
    credit: 'JonRidinger / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Petco Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Petco_Park_Padres_Game.jpg',
    credit: 'Mds08011 / Wikimedia Commons, CC BY 4.0',
  },
  'PNC Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Pedro_goes_to_Pittsburgh.jpg',
    credit: 'alpineinc / Wikimedia Commons, CC BY 2.0',
  },
  'Progressive Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Progressive_Field.jpg',
    credit: 'Jsawczuk / Wikimedia Commons, Public domain',
  },
  'Rate Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Uscellular.jpg',
    credit: 'User Enoch Lai on en.wikipedia / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Raymond James Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Raymond_James_Stadium_aerial.jpg',
    credit: 'NASA / Wikimedia Commons, Public domain',
  },
  'Rocket Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Rocket_Mortgage_FieldHouse_(2).jpg',
    credit: 'Cards84664 / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Rogers Centre': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Rogers_Centre.jpg',
    credit: 'Fabian Roudra Baroi / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Scotiabank Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Air_Canada_Centre_and_CN_Tower_from_Bay_St.jpg',
    credit: 'Secondarywaltz / Wikimedia Commons, Public domain',
  },
  'Smoothie King Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/New_Orleans_Arena%2C_exterior_view%2C_10_January_2022_(cropped).jpg',
    credit: 'Infrogmation of New Orleans / Wikimedia Commons, CC BY-SA 4.0',
  },
  'SoFi Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/SoFi_Stadium_(51126606022).jpg',
    credit: 'Thank You (21 Millions+) views / Wikimedia Commons, CC BY 2.0',
  },
  'Soldier Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Soldier_Field_during_Chicago_Bears_home_game_against_the_San_Francisco_49ers_on_October_29%2C_2006.jpg',
    credit: 'Photo by Joon Han Contact: onejoon@hotmail.com / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Spectrum Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/TWCArena2012.JPG',
    credit: 'HangingCurve / Wikimedia Commons, CC BY-SA 3.0',
  },
  'State Farm Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/2013.01.26.110133_Philips_Arena_Atlanta_Georgia.jpg',
    credit: 'Hermann Luyken / Wikimedia Commons, CC0',
  },
  'State Farm Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Cardinals_stadium_crop.jpg',
    credit: 'Taken by en:Flickr user MCSixth / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Sutter Health Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Rivercats_at_Raley_Field2.JPG',
    credit: 'Mark Miller / Wikimedia Commons, CC BY-SA 3.0',
  },
  'T-Mobile Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/SafecoFieldTop.jpg',
    credit: 'MyName (Cacophony) / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Target Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Target_Center.jpg',
    credit:
      'No machine-readable author provided. Mulad assumed (based on copyright claims). / Wikimedia Commons, Public domain',
  },
  'Target Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Target_Field_(4051860538).jpg',
    credit: 'Jerry Huddleston from Hampton, Minnesota, US / Wikimedia Commons, CC BY 2.0',
  },
  'TD Garden': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/TD_Garden.JPG',
    credit: 'Nywalton at English Wikipedia / Wikimedia Commons, Public domain',
  },
  'Toyota Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Toyota_Center_entr.jpg',
    credit: 'Ed Uthman from Houston, TX, USA / Wikimedia Commons, CC BY 2.0',
  },
  'Tropicana Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Tropicana_Field_Playing_Field_Opening_Day_2010.JPG',
    credit: 'EaglesFanInTampa / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Truist Park': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/SunTrust_Park_Opening_Day_2017.jpg',
    credit: 'Thechased at English Wikipedia / Wikimedia Commons, CC BY 4.0',
  },
  'U.S. Bank Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/US_Bank_Stadium_-_West_Facade.jpg',
    credit: 'Darb02 / Wikimedia Commons, CC BY-SA 4.0',
  },
  'United Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/United_Center_060716.jpg',
    credit: 'User:JeremyA / Wikimedia Commons, CC BY-SA 2.5',
  },
  'Wintrust Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Wintrust-arena-exterior.jpg',
    credit: 'Swinterroth / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Wrigley Field': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Wrigley_Field_2018_-_42195054760.jpg',
    credit: 'Ryan Dickey / Wikimedia Commons, CC BY 2.0',
  },
  'Xfinity Mobile Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Wells_Fargo_Center_-_2019_OWL_Grand_Finals.jpg',
    credit: 'Jen Smith / Wikimedia Commons, CC BY 3.0',
  },
  'Yankee Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Yankee_Stadium_upper_deck_2010.jpg',
    credit: 'Matt Boulton / Wikimedia Commons, CC BY-SA 2.0',
  },
  // 2026-08-06 expansion (owner note "event pages should always have pictures"):
  // 20 venues referenced by the pro schedule that had no photo. Sourced the same
  // way as the rest — Wikidata P18 → Commons, attribution verified, each image
  // URL confirmed to load. Several use the building's former name (same venue,
  // renamed): Climate Pledge=KeyArena, Enterprise=Scottrade, Pechanga=SD Sports
  // Arena, SNHU=Verizon Wireless, Coca-Cola Coliseum=Ricoh, Tom Benson=Fawcett.
  'American Bank Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/AmericanBankCenterCorpus.jpg',
    credit: 'WhisperToMe / Wikimedia Commons, CC0',
  },
  'Arena CDMX': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/ACMX16.JPG',
    credit: 'Santix1988 / Wikimedia Commons, CC BY-SA 3.0',
  },
  Cajundome: {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Cajundome_Afternoon.JPG',
    credit: 'Jcarriere at en.wikipedia / Wikimedia Commons, Public domain',
  },
  'Canada Life Place': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Canada_Life_Place%2C_formly_the_called_Budweiser_Gardens.jpg',
    credit: 'Gogerr / Wikimedia Commons, CC BY 4.0',
  },
  'Canadian Tire Centre': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Canadian_Tire_Centre_1.JPG',
    credit: 'Ontario Images / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Climate Pledge Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/KeyArena_(2890740573).jpg',
    credit: 'Cliff from Arlington, Virginia, USA / Wikimedia Commons, CC BY 2.0',
  },
  'Coca-Cola Coliseum': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ricohcoliseum.jpg',
    credit: 'Diego Torres Silvestre / Wikimedia Commons, CC BY 2.0',
  },
  'College Park Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/University_of_Texas_at_Arlington_March_2021_008_(College_Park_Center).jpg',
    credit: 'Michael Barera / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Enterprise Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Scottrade_Center_3Apr2005.jpg',
    credit: 'Haaron755 / Wikimedia Commons, CC BY-SA 3.0',
  },
  'KeyBank Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/KeyBank_Center_side_view_from_Main_Street_at_Prime_Street%2C_Buffalo%2C_New_York_-_20210725.jpg',
    credit: 'Andre Carrotflower / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Legacy Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Legacy_Arena_2022.jpg',
    credit: 'AuburnShuffle / Wikimedia Commons, CC0',
  },
  "Levi's Stadium": {
    url: "https://commons.wikimedia.org/wiki/Special:FilePath/Levi's_Stadium_interior_1.jpg",
    credit: 'Matthew Roth / Wikimedia Commons, CC BY-SA 2.0',
  },
  'Michelob Ultra Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/MandalayBay2010.JPG',
    credit: 'Kris1123 / Wikimedia Commons, CC BY 3.0',
  },
  'North Charleston Coliseum': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/North_Charleston_Coliseum_Aug2010.jpg',
    credit: 'Chris Pruitt / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Pechanga Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/San_Diego_Sports_Arena.jpg',
    credit: 'Nehrams2020 / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Rogers Place': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Rogers_Place%2C_Edmonton%2C_June_6%2C_2024.jpg',
    credit: 'D. Benjamin Miller / Wikimedia Commons, CC0',
  },
  'Save Mart Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/2009-0725-CA-SaveMartCenter.jpg',
    credit: "Bobak Ha'Eri / Wikimedia Commons, CC BY 3.0",
  },
  'Scotiabank Saddledome': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/2020_Calgary_Saddledome.jpg',
    credit: 'AceYYC / Wikimedia Commons, CC BY-SA 4.0',
  },
  'SNHU Arena': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Verizon_Wireless_Arena_front.jpg',
    credit:
      'ToddC4176 at English Wikipedia (Original text: T.S. Custadio ToddC4176) / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Tom Benson Hall of Fame Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Fawcett_Stadium.jpg',
    credit: 'Harrier233 at English Wikipedia / Wikimedia Commons, Public domain',
  },
  'Aviva Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Dublin_aviva_stadium.jpg',
    credit: 'Arne Museler / Wikimedia Commons, CC BY-SA 3.0 de',
  },
  'Doak Campbell Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Doak_Campbell_Stadium_-_FSU.JPG',
    credit: 'Melizabethi123 / Wikimedia Commons, CC BY-SA 3.0',
  },
  Fargodome: {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/2009-0518-Fargodome.jpg',
    credit: "Bobak Ha'Eri / Wikimedia Commons, CC BY 3.0",
  },
  'Los Angeles Memorial Coliseum': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/USC_vs_University_of_Oregon_November_2019.png',
    credit: 'CanonStarGal / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Rynearson Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/WaltDrone4_081524.jpg',
    credit: 'Eastern sid / Wikimedia Commons, CC BY-SA 4.0',
  },
  'Scott Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Scott_Stadium_UVa.jpg',
    credit: 'Mak7912 / Wikimedia Commons, CC BY-SA 3.0',
  },
  'Stanford Stadium': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Stanford_Stadium_new.jpg',
    credit: 'BrokenSphere / Wikimedia Commons, CC BY-SA 3.0',
  },
  'USTA Billie Jean King National Tennis Center': {
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/USTA_Billie_Jean_King_National_Tennis_Center_(48613535076).jpg',
    credit: 'Ajay Suresh / Wikimedia Commons, CC BY 2.0',
  },
};

/** Case-insensitive lookup by venue name (the part before the first comma of an event location). */
export function venuePhotoFor(venueName?: string | null): VenuePhoto | null {
  if (!venueName) return null;
  const key = venueName.split(',')[0].trim();
  if (VENUE_PHOTOS[key]) return VENUE_PHOTOS[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(VENUE_PHOTOS)) if (k.toLowerCase() === lower) return VENUE_PHOTOS[k];
  return null;
}
