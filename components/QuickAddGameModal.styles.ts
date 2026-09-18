import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  headerButton: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  headerButtonDisabled: {
    opacity: 0.6,
  },
  headerButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  helpCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 24,
    gap: 8,
  },
  helpText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  formSection: {
    marginBottom: 24,
  },
  lockedSection: {
    opacity: 0.5,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontWeight: '500',
  },
  gameTypeContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  gameTypeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  gameTypeText: {
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    color: '#EF4444',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 4,
  },
  previewText: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 4,
  },
  previewCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 8,
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  previewSummary: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  previewLocation: {
    fontSize: 13,
    fontWeight: '500',
  },
  bottomSpacer: {
    height: 40,
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  pickerContainer: {
    // Floor the height so the sheet always opens to a usable size — without it
    // the opponent picker collapsed to just the header + search bar (the
    // "stuck super low" device-testing report) when the team list was empty.
    minHeight: '55%',
    maxHeight: '85%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  pickerHeaderButton: {
    fontSize: 16,
    fontWeight: '600',
  },
  pickerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  pickerList: {
    maxHeight: 400,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  pickerItemText: {
    fontSize: 16,
    fontWeight: '500',
  },
  pickerItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  teamLogoContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  teamLogoText: {
    fontSize: 16,
    fontWeight: '600',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
    paddingVertical: 8,
  },
  noResultsContainer: {
    padding: 20,
    alignItems: 'center',
  },
  noResultsText: {
    fontSize: 16,
    fontWeight: '500',
    fontStyle: 'italic',
  },
  // Enhanced preview styles
  matchupContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
    gap: 8,
  },
  teamSide: {
    flex: 1,
    alignItems: 'center',
    gap: 8,
  },
  teamLogoImage: {
    width: '100%',
    height: '100%',
    borderRadius: 25,
  },
  teamLogoPlaceholder: {
    fontSize: 24,
  },
  teamName: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  teamLabel: {
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  vsDivider: {
    alignItems: 'center',
    gap: 4,
    minWidth: 80,
  },
  vsCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vsText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  gameInfo: {
    fontSize: 12,
    textAlign: 'center',
  },
  gameTime: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  gameDetails: {
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 6,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  detailText: {
    fontSize: 14,
    fontWeight: '500',
  },
  bannerUploadSection: {
    marginBottom: 16,
  },
  bannerUploadLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  customBannerContainer: {
    position: 'relative',
  },
  customBannerImage: {
    width: '100%',
    // Preview the uploaded photo at the same fixed height the event detail
    // page renders it at (GameDetailsScreen bannerHeight), so what the user
    // sees here is the size that actually ships.
    height: 240,
    borderRadius: 12,
    backgroundColor: '#D1D5DB',
  },
  customBannerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  bannerActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 4,
  },
  bannerActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  bannerOptionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 8,
  },
  bannerOptionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 4,
  },
  bannerOptionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  helperText: {
    fontSize: 12,
    lineHeight: 16,
  },
  toggle: {
    width: 50,
    height: 28,
    borderRadius: 14,
    padding: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 2px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 2,
        }),
    elevation: 3,
  },
  eventTypeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 4,
  },
  eventTypeCard: {
    width: '31%',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    gap: 8,
  },
  eventTypeLabel: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  eventTypeDescription: {
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 14,
  },
  labelWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  lockedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    backgroundColor: 'rgba(128, 128, 128, 0.1)',
  },
  lockedText: {
    fontSize: 11,
    fontWeight: '600',
  },
  lockedLocationContainer: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  locationIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lockedLocationText: {
    fontSize: 15,
    fontWeight: '500',
  },
  changeLocationLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  changeLocationText: {
    fontSize: 13,
    fontWeight: '600',
  },
  mapsLinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
  },
  mapsLinkText: {
    fontSize: 14,
    fontWeight: '600',
  },
  liveNotice: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
    alignItems: 'center',
  },
  liveNoticeIcon: {
    marginRight: 12,
  },
  liveNoticeTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  liveNoticeSubtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
});
