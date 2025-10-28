import React from 'react';
import { Image, TextInput, TouchableOpacity, ImageBackground } from 'react-native';
import { ICONS } from '@/constants/icons';
import { COLORS } from '@/constants/colors';
import { IMAGES } from '@/constants/images';

interface Props {
  placeholder: string;
  onPress?: () => void;
}

export const SearchBar = ({ placeholder, onPress }: Props) => {
  return (
    <ImageBackground
      source={IMAGES.searchBar}
      style={{
        borderRadius: 40,
        overflow: 'hidden',
        paddingHorizontal: 8,
      }}
    >
      <TouchableOpacity
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: 40,
          paddingHorizontal: 12,
          paddingVertical: 8,
          height: 48,
        }}
        onPress={onPress}
        activeOpacity={0.8}
      >
        {/* Search Icon */}
        <Image
          source={ICONS.search}
          resizeMode="contain"
          style={{
            tintColor: COLORS.white,
            width: 20,
            height: 20,
          }}
        />
        {/* user text input props */}
        <TextInput
          onPress={onPress}
          placeholder={placeholder}
          placeholderTextColor={COLORS.grey}
          style={{
            flex: 1,
            marginLeft: 8,
            color: COLORS.white,
            fontSize: 14,
            textAlignVertical: 'center', 
            padding: 0, 
          }}
        />
      </TouchableOpacity>
    </ImageBackground>
  );
};

export default SearchBar;